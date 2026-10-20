const mongoose = require('mongoose');

const encryptedValueSchema = new mongoose.Schema({
  version: { type: Number, required: true },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  data: { type: String, required: true },
}, { _id: false });

const tradingAccountSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // mt5_import: an MT5 account whose trades come from uploaded MT5 reports
  // (no login stored, never synced by the desktop app -- e.g. MT5 on a Mac).
  // mt5_terminal: found open in a running MT5 terminal by the desktop agent,
  // which reads it there without logging in (no login stored, like mt5_import).
  provider: { type: String, enum: ['mt5', 'ctrader', 'mt5_import', 'mt5_terminal'], default: 'mt5' },
  accountKey: { type: String, required: true },
  label: { type: String, required: true, trim: true, maxlength: 80 },
  credentials: {
    // cTrader accounts authenticate via the OAuth connection in CTraderConnection,
    // not a login/password/server triplet, so these are only required for MT5.
    login: { type: encryptedValueSchema, required: function isMt5() { return this.provider === 'mt5'; } },
    password: { type: encryptedValueSchema, required: function isMt5() { return this.provider === 'mt5'; } },
    server: { type: encryptedValueSchema, required: function isMt5() { return this.provider === 'mt5'; } },
  },
  // mt5_import only: the MT5 login and server read from the report, so the next report finds this account.
  statementLogin: { type: String, default: '', maxlength: 20 },
  statementServer: { type: String, default: '', maxlength: 160 },
  enabled: { type: Boolean, default: true },
  archivedAt: { type: Date, default: null },
  requireRealAccount: { type: Boolean, default: false },
  symbolAliases: { type: String, default: '', maxlength: 2000 },
  lastStatus: { type: String, enum: ['pending', 'connected', 'error', 'disabled'], default: 'pending' },
  lastError: { type: String, default: '', maxlength: 500 },
  lastConnectedAt: { type: Date, default: null },
  lastSyncAt: { type: Date, default: null },
  // cTrader: set once stops have been read back for every trade synced before that existed.
  stopsBackfilledAt: { type: Date, default: null },
  lastAgentSeenAt: { type: Date, default: null },
  lastBalance: { type: Number, default: null },
  actualAccountType: { type: String, enum: ['live', 'demo', ''], default: '' },
  // Read-only investor access, modeled on how MT5 itself separates a
  // full-control master password from a view-only investor password tied to
  // the same account number. `code` is the public-facing "account number" a
  // viewer logs in with; `passwordHash` is bcrypt so the plaintext password
  // exists only at generation time (shown once) and can never be recovered,
  // only rotated. Clearing passwordHash instantly revokes every session,
  // since investor requests re-check it on every call rather than trusting
  // a long-lived JWT alone.
  investor: {
    enabled: { type: Boolean, default: false },
    // No default: the unique index only skips accounts *without* a code, so
    // an explicit null on two accounts collides (E11000 on the second one).
    code: { type: String },
    passwordHash: { type: String, default: null },
    createdAt: { type: Date, default: null },
    lastViewedAt: { type: Date, default: null },
  },
}, { timestamps: true });

tradingAccountSchema.index({ user: 1, accountKey: 1 }, { unique: true });
tradingAccountSchema.index({ user: 1, archivedAt: 1, enabled: 1 });
tradingAccountSchema.index({ 'investor.code': 1 }, { unique: true, sparse: true });

// Accounts saved while `code` defaulted to null block every new account
// (duplicate null in the unique index): clear those nulls once on start.
mongoose.connection.on('connected', async () => {
  try {
    await mongoose.connection.collection('tradingaccounts').updateMany({ 'investor.code': null }, { $unset: { 'investor.code': '' } });
  } catch (_err) {
    // Collection may not exist yet on a fresh database -- nothing to clean.
  }
});

module.exports = mongoose.model('TradingAccount', tradingAccountSchema);
