const mongoose = require('mongoose');

const syncRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  forceFullSync: { type: Boolean, default: false },
  requestedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('SyncRequest', syncRequestSchema);
