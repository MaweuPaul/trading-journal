const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  ownerKey: {
    type: String,
    default: 'owner',
    unique: true,
    immutable: true,
  },
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
  tradingRules: [{
    ruleId: { type: String, required: true },
    label: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, enum: ['pre_trade', 'execution'], required: true },
    enabled: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  }],
  playbooks: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
