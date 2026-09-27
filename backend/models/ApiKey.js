const mongoose = require('mongoose');

// Personal access keys for AI agents (the MCP endpoint). Only a SHA-256 hash
// of the key is stored; the plaintext is shown once, at creation. A key can
// reach the MCP tools and nothing else -- it is not a JWT, so the normal
// `auth` middleware rejects it on every other route. Scopes: 'backtest'
// (always) and 'journal' (opt-in: read-only access to the real trades).
const apiKeySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  keyHash: { type: String, required: true, unique: true },
  prefix: { type: String, required: true }, // first characters, to tell keys apart in the UI
  scopes: { type: [String], default: ['backtest'] },
  lastUsedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  // 'key': created on the Accounts page, never expires. 'oauth': a connection an
  // app (e.g. claude.ai) made through the OAuth sign-in (routes/oauth.js); its
  // keyHash is a short-lived access token, rotated with the refresh token.
  kind: { type: String, enum: ['key', 'oauth'], default: 'key' },
  clientId: { type: String, default: null },
  expiresAt: { type: Date, default: null },
  // No default: a sparse unique index skips documents where the field is
  // MISSING, but indexes explicit nulls -- so `default: null` made every key
  // after the first collide on refreshHash: null (E11000). Only OAuth
  // connections ever set it.
  refreshHash: { type: String, index: { unique: true, sparse: true } },
  refreshExpiresAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('ApiKey', apiKeySchema);
