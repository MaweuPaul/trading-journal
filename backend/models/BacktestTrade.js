const mongoose = require('mongoose');

// A hypothetical trade the user placed against historical candles while
// backtesting a setup -- entirely separate from Trade (real, broker-synced
// history), so backtests never leak into Dashboard/Analytics/Performance
// numbers. The chart used to place it is drawable the same way Pre-Trade
// Analysis and Trade Replay are (see chartAnnotations).
function isReplay() { return this.source !== 'quick'; }

const backtestTradeSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  name: { type: String, default: '' },
  // Primary strategy -- always tags[0] when tags exist, kept as its own
  // field so older backtests and the "By Strategy" breakdown keep working.
  strategy: { type: String, default: '', index: true },
  tags: { type: [String], default: [], index: true },
  // 'replay' = placed on the Backtest chart; 'quick' = logged by hand from
  // the Backtest Log (label/symbol/direction/P&L/R only -- no prices);
  // 'agent' = placed by an AI agent through the MCP replay tools.
  source: { type: String, enum: ['replay', 'quick', 'agent'], default: 'replay' },
  // Agent trades placed in a blind session (dates and prices hidden from the agent).
  blind: { type: Boolean, default: false },
  // Market conditions when the trade was entered (e.g. { atr14: 4.2, riskInAtr: 1.3,
  // rangeWidth: 3.1 }), so results can be split by them. Agent trades only, for now.
  features: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Version of the strategy's rules (BacktestStrategy.versions) the trade was taken under.
  strategyVersion: { type: Number, default: null },
  // The run_strategy run that logged it (agent trades), so a run's trades can be removed together.
  strategyRun: { type: String, default: undefined, index: true, sparse: true },
  symbol: { type: String, required: true },
  interval: { type: String, default: '' },
  direction: { type: String, enum: ['long', 'short'], required: true },

  entryTime: { type: Number, required: isReplay },
  entryPrice: { type: Number, required: isReplay },
  exitTime: { type: Number, required: isReplay },
  exitPrice: { type: Number, required: isReplay },
  stopLoss: { type: Number, required: isReplay },
  takeProfit: { type: Number, default: null },
  // Managed trades: the stop the trade went live with (1R) -- stopLoss above is
  // where it ended, after a move to break-even or trailing -- and profit
  // taken along the way. rMultiple/pnlUSD already include the partials.
  initialStopLoss: { type: Number, default: null },
  partials: {
    type: [{ _id: false, time: Number, price: Number, fraction: Number }],
    default: undefined,
  },
  // How the entry filled: at market, or as a pending limit/stop order.
  orderType: { type: String, enum: ['market', 'limit', 'stop'], default: undefined },

  outcome: { type: String, enum: ['win', 'loss', 'breakeven'], required: true },
  riskAmount: { type: Number, default: 0 },
  lots: { type: Number, default: null }, // position size from the symbol's contract size (null if unknown)
  pnlUSD: { type: Number, default: 0 },
  rMultiple: { type: Number, default: 0 },

  notes: { type: String, default: '' },
  planFollowed: { type: Boolean, default: null },
  setupQuality: { type: Number, min: 0, max: 5, default: 0 },
  executionQuality: { type: Number, min: 0, max: 5, default: 0 },
  mistakes: { type: [String], default: [] },
  lesson: { type: String, default: '' },
  // Small JPEG data URL of the chart at save time (Log's "Setup Snapshot").
  // Excluded from list queries; fetched on demand via /backtest-trades/:id/snapshot.
  snapshot: { type: String, default: '', select: false },
  chartAnnotations: { type: mongoose.Schema.Types.Mixed, default: [] },
}, { timestamps: true });

module.exports = mongoose.model('BacktestTrade', backtestTradeSchema);
