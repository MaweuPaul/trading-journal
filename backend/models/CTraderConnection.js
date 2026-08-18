const mongoose = require('mongoose');

const encryptedValueSchema = new mongoose.Schema({
  version: { type: Number, required: true },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  data: { type: String, required: true },
}, { _id: false });

// An owner can hold one cTrader connection per trading account, potentially
// spanning multiple cTrader logins (e.g. one under their own name, another
// under a partner's) — so this is one row per (user, ctidTraderAccountId),
// not one row per user. A row with ctidTraderAccountId '' is a transient
// "pending" state: tokens have been exchanged but the owner hasn't picked
// which account(s) to actually connect yet (see routes/ctrader.js). Tokens
// are stored encrypted the same way MT5 broker credentials are (see
// lib/credentialEncryption.js).
const cTraderConnectionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  accessToken: { type: encryptedValueSchema, required: true },
  refreshToken: { type: encryptedValueSchema, required: true },
  expiresAt: { type: Date, required: true },
  ctidTraderAccountId: { type: String, default: '' },
  isLive: { type: Boolean, default: false },
  brokerTitle: { type: String, default: '' },
  traderLogin: { type: String, default: '' },
  connectedAt: { type: Date, default: Date.now },
}, { timestamps: true });

cTraderConnectionSchema.index({ user: 1, ctidTraderAccountId: 1 }, { unique: true });

// Earlier versions of this app allowed only one cTrader connection per user
// and enforced that with a unique index on `user` alone. That index has to
// be dropped before a second connection can ever be inserted for an
// existing user — Mongoose's autoIndex only adds missing indexes, it never
// removes or replaces one that's no longer in the schema.
mongoose.connection.on('connected', async () => {
  try {
    const indexes = await mongoose.connection.collection('ctraderconnections').indexes();
    const staleUserIndex = indexes.find(index => index.unique && Object.keys(index.key).length === 1 && index.key.user === 1);
    if (staleUserIndex) await mongoose.connection.collection('ctraderconnections').dropIndex(staleUserIndex.name);
  } catch (_err) {
    // Collection may not exist yet on a fresh database — nothing to migrate.
  }
});

module.exports = mongoose.model('CTraderConnection', cTraderConnectionSchema);
