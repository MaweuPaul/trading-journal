const mongoose = require('mongoose');

// A one-time authorization code from the consent page, exchanged at the token
// endpoint within 10 minutes (PKCE-bound). Only its hash is stored.
const oauthCodeSchema = new mongoose.Schema({
  codeHash: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientId: { type: String, required: true },
  redirectUri: { type: String, required: true },
  codeChallenge: { type: String, required: true },
  scopes: { type: [String], default: ['backtest'] },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  usedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('OAuthCode', oauthCodeSchema);
