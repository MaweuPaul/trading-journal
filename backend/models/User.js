const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
  },
  // SHA-256 of this user's personal MT5 sync-agent secret (see
  // routes/auth.js POST /sync-agent). Stored as a lookup hash rather than a
  // bcrypt hash: this is a high-entropy random token, not a low-entropy
  // password, and the sync agent needs a fast direct-lookup match rather
  // than an iterate-and-compare, so a plain deterministic hash is
  // appropriate here (same tradeoff any API-key design makes).
  syncSecretHash: {
    type: String,
    select: false,
  },
  tradingRules: [{
    ruleId: { type: String, required: true },
    label: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, enum: ['pre_trade', 'execution'], required: true },
    enabled: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  }],
  playbooks: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });

userSchema.index({ syncSecretHash: 1 }, { unique: true, sparse: true });

// This app was single-owner until it grew multi-user support: every existing
// document carries a legacy `ownerKey: 'owner'` unique index that would
// block ever inserting a second user. Mongoose's autoIndex only adds
// missing indexes, it never drops one that's no longer in the schema.
mongoose.connection.on('connected', async () => {
  try {
    const indexes = await mongoose.connection.collection('users').indexes();
    const staleOwnerIndex = indexes.find(index => index.key?.ownerKey === 1);
    if (staleOwnerIndex) await mongoose.connection.collection('users').dropIndex(staleOwnerIndex.name);
  } catch (_err) {
    // Collection may not exist yet on a fresh database — nothing to migrate.
  }
});

module.exports = mongoose.model('User', userSchema);
