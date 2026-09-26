const mongoose = require('mongoose');

// A named strategy the user is testing, created up front so it exists before
// any trade is ever logged against it -- unlike BacktestTrade.tags, which
// only ever reflects strategies that already have at least one saved trade.
const backtestStrategySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  // Rule history, written by AI agents (MCP) as they refine a strategy. The
  // latest version's rules are always mirrored in `description`.
  versions: {
    type: [{
      version: { type: Number, required: true },
      rules: { type: String, default: '' },
      change: { type: String, default: '' },        // what changed and why
      createdAt: { type: Date, default: Date.now },
      holdoutResult: { type: mongoose.Schema.Types.Mixed, default: null }, // first held-out evaluation, frozen
      holdoutSeenBefore: { type: Boolean, default: false }, // held-out data had already been looked at when this version was made
    }],
    default: [],
  },
  // Trades entered on/after this date are held out: their results are hidden
  // from agents except through evaluate_holdout, and every look is counted.
  holdoutFrom: { type: Date, default: null },
  holdoutEvaluations: { type: Number, default: 0 },
}, { timestamps: true });

backtestStrategySchema.index({ user: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('BacktestStrategy', backtestStrategySchema);
