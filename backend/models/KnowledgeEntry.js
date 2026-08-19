const mongoose = require('mongoose');

// A personal knowledge base -- separate from per-trade journal notes on
// Trade. Not tied to any trade, account, or symbol; just general trading
// knowledge, findings, and notes with optional screenshots (chart concepts,
// broker docs, market structure ideas).
const knowledgeEntrySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  content: { type: String, default: '', maxlength: 20000 },
  tags: { type: [String], default: [] },
  screenshots: [{
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    caption: { type: String, default: '' },
    uploadedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

knowledgeEntrySchema.index({ user: 1, createdAt: -1 });
knowledgeEntrySchema.index({ user: 1, tags: 1 });

module.exports = mongoose.model('KnowledgeEntry', knowledgeEntrySchema);
