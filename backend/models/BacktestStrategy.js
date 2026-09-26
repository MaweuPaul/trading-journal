const mongoose = require('mongoose');

// A named strategy the user is testing, created up front so it exists before
// any trade is ever logged against it -- unlike BacktestTrade.tags, which
// only ever reflects strategies that already have at least one saved trade.
const backtestStrategySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
}, { timestamps: true });

backtestStrategySchema.index({ user: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('BacktestStrategy', backtestStrategySchema);
