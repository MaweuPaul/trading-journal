const mongoose = require('mongoose');

// One run_strategy backtest (lib/strategyRunner.js): the agent's strategy
// code, its settings, progress while it runs, and the trades it produced.
const strategyRunSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  apiKey: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiKey', default: null },
  status: { type: String, enum: ['running', 'done', 'error', 'cancelled'], default: 'running' },
  name: { type: String, default: '', maxlength: 100 },
  code: { type: String, required: true },
  settings: { type: mongoose.Schema.Types.Mixed, default: {} },
  progress: { type: mongoose.Schema.Types.Mixed, default: {} },
  error: { type: mongoose.Schema.Types.Mixed, default: null },
  trades: { type: [mongoose.Schema.Types.Mixed], default: [] },
  heldOutTrades: { type: Number, default: 0 },
  rejected: { type: mongoose.Schema.Types.Mixed, default: null },
  logs: { type: [String], default: [] },
  logCount: { type: Number, default: 0 },
  loggedTo: { type: mongoose.Schema.Types.Mixed, default: null },
  finishedAt: { type: Date, default: null },
}, { timestamps: true });

strategyRunSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('StrategyRun', strategyRunSchema);
