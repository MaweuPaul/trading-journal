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
  // the Backtest Log (label/symbol/direction/P&L/R only -- no prices).
  source: { type: String, enum: ['replay', 'quick'], default: 'replay' },
  symbol: { type: String, required: true },
  interval: { type: String, default: '' },
  direction: { type: String, enum: ['long', 'short'], required: true },

  entryTime: { type: Number, required: isReplay },
  entryPrice: { type: Number, required: isReplay },
  exitTime: { type: Number, required: isReplay },
  exitPrice: { type: Number, required: isReplay },
  stopLoss: { type: Number, required: isReplay },
  takeProfit: { type: Number, default: null },

  outcome: { type: String, enum: ['win', 'loss', 'breakeven'], required: true },
  riskAmount: { type: Number, default: 0 },
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
