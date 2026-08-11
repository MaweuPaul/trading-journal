const mongoose = require('mongoose');

const replaySessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trade', required: true, index: true },
  status: { type: String, enum: ['pending', 'processing', 'ready', 'failed'], default: 'pending', index: true },
  request: { type: mongoose.Schema.Types.Mixed, required: true },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  error: { type: String, default: '' },
  claimCount: { type: Number, default: 0 },
  claimedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

replaySessionSchema.index({ user: 1, tradeId: 1 }, { unique: true });

module.exports = mongoose.model('ReplaySession', replaySessionSchema);
