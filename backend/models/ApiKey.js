const mongoose = require('mongoose');

// Personal access keys for AI agents (the MCP endpoint). Only a SHA-256 hash
// of the key is stored; the plaintext is shown once, at creation. A key can
// reach the backtest MCP tools and nothing else -- it is not a JWT, so the
// normal `auth` middleware rejects it on every other route.
const apiKeySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  keyHash: { type: String, required: true, unique: true },
  prefix: { type: String, required: true }, // first characters, to tell keys apart in the UI
  scopes: { type: [String], default: ['backtest'] },
  lastUsedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('ApiKey', apiKeySchema);
