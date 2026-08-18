const mongoose = require('mongoose');

const accountEventSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'adjustment'],
    required: true,
  },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
  occurredAt: { type: Date, required: true, default: Date.now },
  note: { type: String, default: '' },
  source: {
    type: String,
    enum: ['manual', 'mt5', 'ctrader'],
    default: 'manual',
  },
  externalId: { type: String, default: '' },
  balanceAfter: { type: Number, default: null },
  accountKey: { type: String, default: '', index: true },
  tradingAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', default: null, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
}, { timestamps: true });

accountEventSchema.index({ user: 1, occurredAt: -1 });
accountEventSchema.index(
  { user: 1, accountKey: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { source: { $in: ['mt5', 'ctrader'] } } },
);

module.exports = mongoose.model('AccountEvent', accountEventSchema);
