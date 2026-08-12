const mongoose = require('mongoose');

const encryptedValueSchema = new mongoose.Schema({
  version: { type: Number, required: true },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  data: { type: String, required: true },
}, { _id: false });

const tradingAccountSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: ['mt5'], default: 'mt5' },
  accountKey: { type: String, required: true },
  label: { type: String, required: true, trim: true, maxlength: 80 },
  credentials: {
    login: { type: encryptedValueSchema, required: true },
    password: { type: encryptedValueSchema, required: true },
    server: { type: encryptedValueSchema, required: true },
  },
  enabled: { type: Boolean, default: true },
  archivedAt: { type: Date, default: null },
  requireRealAccount: { type: Boolean, default: false },
  symbolAliases: { type: String, default: '', maxlength: 2000 },
  lastStatus: { type: String, enum: ['pending', 'connected', 'error', 'disabled'], default: 'pending' },
  lastError: { type: String, default: '', maxlength: 500 },
  lastConnectedAt: { type: Date, default: null },
  lastSyncAt: { type: Date, default: null },
  lastAgentSeenAt: { type: Date, default: null },
  lastBalance: { type: Number, default: null },
  actualAccountType: { type: String, enum: ['live', 'demo', ''], default: '' },
}, { timestamps: true });

tradingAccountSchema.index({ user: 1, accountKey: 1 }, { unique: true });
tradingAccountSchema.index({ user: 1, archivedAt: 1, enabled: 1 });

module.exports = mongoose.model('TradingAccount', tradingAccountSchema);
