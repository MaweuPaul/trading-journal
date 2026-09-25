const mongoose = require('mongoose');

// A hypothetical trade the user placed against historical candles while
// backtesting a setup -- entirely separate from Trade (real, broker-synced
// history), so backtests never leak into Dashboard/Analytics/Performance
// numbers. The chart used to place it is drawable the same way Pre-Trade
// Analysis and Trade Replay are (see chartAnnotations).
const backtestTradeSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  name: { type: String, default: '' },
  strategy: { type: String, default: '', index: true },
  symbol: { type: String, required: true },
  interval: { type: String, required: true },
  direction: { type: String, enum: ['long', 'short'], required: true },

  entryTime: { type: Number, required: true },
  entryPrice: { type: Number, required: true },
  exitTime: { type: Number, required: true },
  exitPrice: { type: Number, required: true },
  stopLoss: { type: Number, required: true },
  takeProfit: { type: Number, default: null },

  outcome: { type: String, enum: ['win', 'loss', 'breakeven'], required: true },
  riskAmount: { type: Number, default: 0 },
  pnlUSD: { type: Number, default: 0 },
  rMultiple: { type: Number, default: 0 },

  notes: { type: String, default: '' },
  chartAnnotations: { type: mongoose.Schema.Types.Mixed, default: [] },
}, { timestamps: true });

module.exports = mongoose.model('BacktestTrade', backtestTradeSchema);
