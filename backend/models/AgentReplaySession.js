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
  takeProfit: { type: Number, default: null },
  riskAmount: { type: Number, default: 100 },
  exitTime: Number,
  exitPrice: Number,
  exitReason: { type: String, enum: ['stop', 'target', 'manual'] },
  outcome: { type: String, enum: ['win', 'loss', 'breakeven'] },
  rMultiple: Number,
  pnlUSD: Number,
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
  openTrade: { type: tradeSchema, default: null },
  closedTrade: { type: tradeSchema, default: null }, // resolved, waiting to be logged or discarded
  loggedTrades: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'ended'], default: 'active' },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

module.exports = mongoose.model('AgentReplaySession', agentReplaySessionSchema);
