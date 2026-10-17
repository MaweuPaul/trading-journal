const mongoose = require('mongoose');

// Which calendar months have been fetched from the news API, so the
// background sync knows what's left to backfill and what's due a refresh.
const newsMonthSchema = new mongoose.Schema({
  month: { type: String, required: true, unique: true }, // 'YYYY-MM'
  fetchedAt: { type: Date, default: null },
  count: { type: Number, default: 0 },
  error: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('NewsMonth', newsMonthSchema);
