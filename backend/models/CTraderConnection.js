const mongoose = require('mongoose');

const encryptedValueSchema = new mongoose.Schema({
  version: { type: Number, required: true },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  data: { type: String, required: true },
}, { _id: false });

// One connection per owner: the OAuth tokens for this journal's cTrader Open
// API app, plus which of the owner's cTrader trading accounts to pull Replay
// candles from. Tokens are stored encrypted the same way MT5 broker
// credentials are (see lib/credentialEncryption.js).
const cTraderConnectionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  accessToken: { type: encryptedValueSchema, required: true },
  refreshToken: { type: encryptedValueSchema, required: true },
  expiresAt: { type: Date, required: true },
  ctidTraderAccountId: { type: String, default: '' },
  isLive: { type: Boolean, default: false },
  brokerTitle: { type: String, default: '' },
  traderLogin: { type: String, default: '' },
  connectedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('CTraderConnection', cTraderConnectionSchema);
