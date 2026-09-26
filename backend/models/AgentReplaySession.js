const mongoose = require('mongoose');

// A bar-by-bar replay run by an AI agent over MCP. The replay clock lives
// here, on the server, so an agent can never be sent a candle that closes
// after it -- the same no-hindsight rule the Backtest chart enforces in the
// browser. Sessions expire a week after their last use.
const tradeSchema = new mongoose.Schema({
  direction: { type: String, enum: ['long', 'short'], required: true },
  entryTime: { type: Number, required: true },   // open time (unix s) of the candle it was placed on
  entryPrice: { type: Number, required: true },
  stopLoss: { type: Number, required: true },
  // The stop the trade was opened with: R is always measured against it,
  // even after modify_trade moves the stop (e.g. to breakeven).
  initialStopLoss: Number,
  takeProfit: { type: Number, default: null },
  riskAmount: { type: Number, default: 100 },
  exitTime: Number,
  exitPrice: Number,
  exitReason: { type: String, enum: ['stop', 'target', 'manual'] },
  outcome: { type: String, enum: ['win', 'loss', 'breakeven'] },
  rMultiple: Number,
  pnlUSD: Number,
  features: { type: mongoose.Schema.Types.Mixed, default: undefined }, // captured at entry
}, { _id: false });

// A limit/stop entry waiting to be filled. Fills are settled on 1-minute
// candles as the replay steps.
const orderSchema = new mongoose.Schema({
  type: { type: String, enum: ['limit', 'stop'], required: true },
  direction: { type: String, enum: ['long', 'short'], required: true },
  price: { type: Number, required: true },
  stopLoss: { type: Number, required: true },
  takeProfit: { type: Number, default: null },
  riskAmount: { type: Number, default: 100 },
  placedAt: { type: Number, required: true },  // clock (unix s) when placed
  expiresAt: { type: Number, default: null },  // unix s; null = good till cancelled
  features: { type: mongoose.Schema.Types.Mixed, default: undefined }, // captured when placed
}, { _id: false });

const agentReplaySessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  apiKey: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiKey' },
  symbol: { type: String, required: true },
  interval: { type: String, required: true },    // timeframe the replay steps in
  fromMs: { type: Number, required: true },
  toMs: { type: Number, required: true },
  clock: { type: Number, required: true },       // unix s: close time of the last revealed candle
  strategy: { type: String, default: '' },
  strategyVersion: { type: Number, default: null }, // rules version in force when the session started
  pendingOrder: { type: orderSchema, default: null },
  openTrade: { type: tradeSchema, default: null },
  closedTrade: { type: tradeSchema, default: null }, // resolved, waiting to be logged or discarded
  loggedTrades: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'ended'], default: 'active' },
  // Blind mode: the agent never learns where in history it is. The window is
  // picked at random, times are shifted by whole weeks (weekday and time of
  // day survive) and prices are multiplied by a random factor. Everything
  // stored here -- clock, trades -- stays in real time and real prices; only
  // what goes over the wire is transformed.
  blind: {
    enabled: { type: Boolean, default: false },
    timeShift: { type: Number, default: 0 },   // seconds subtracted from real time
    priceScale: { type: Number, default: 1 },  // agent price = real price * priceScale
  },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

module.exports = mongoose.model('AgentReplaySession', agentReplaySessionSchema);
