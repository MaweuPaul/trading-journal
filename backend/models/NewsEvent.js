const mongoose = require('mongoose');

// One economic calendar release (Forex Factory, via the JBlanked News API).
// Shared by every user: the calendar is the same for everyone.
const newsEventSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // source|currency|name|time
  source: { type: String, default: 'forex-factory' },
  currency: { type: String, required: true },
  name: { type: String, required: true },
  impact: { type: String, enum: ['High', 'Medium', 'Low', 'None'], default: 'None' },
  time: { type: Date, required: true }, // UTC
  actual: { type: mongoose.Schema.Types.Mixed, default: null },
  forecast: { type: mongoose.Schema.Types.Mixed, default: null },
  previous: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

newsEventSchema.index({ time: 1, currency: 1 });

module.exports = mongoose.model('NewsEvent', newsEventSchema);
