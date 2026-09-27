const mongoose = require('mongoose');

// An app registered itself for the OAuth sign-in (RFC 7591 dynamic client
// registration), e.g. claude.ai adding the journal as a custom connector.
// Public clients only (PKCE, no secret).
const oauthClientSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  name: { type: String, default: 'An app', maxlength: 100 },
  redirectUris: { type: [String], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('OAuthClient', oauthClientSchema);
