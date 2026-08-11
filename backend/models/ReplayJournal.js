const mongoose = require('mongoose');

const replayJournalSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  trade: { type: mongoose.Schema.Types.ObjectId, ref: 'Trade', required: true, index: true },
  schemaVersion: { type: Number, default: 1 },
  revision: { type: Number, default: 0 },
  annotationsByInterval: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

replayJournalSchema.index({ user: 1, trade: 1 }, { unique: true });

module.exports = mongoose.model('ReplayJournal', replayJournalSchema);
