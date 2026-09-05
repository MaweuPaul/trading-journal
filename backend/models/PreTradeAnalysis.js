const mongoose = require('mongoose');

// A standalone answer sheet for a playbook's Plan-phase questions (bias,
// setup, entry confirmation, risk), fillable before any real Trade exists.
// Manually inherited into a Trade's journal later (see PUT /trades/:id and
// the "Inherit From Pre-Trade Analysis" flow), the same way a re-entry
// inherits from its parent trade -- this record itself never becomes a Trade.
const preTradeAnalysisSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  playbookId: { type: String, required: true },
  playbookVersionId: { type: String, required: true },
  playbookSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  responses: { type: mongoose.Schema.Types.Mixed, default: {} },

  symbol: { type: String, default: '' },
  direction: { type: String, enum: ['long', 'short', ''], default: '' },
  notes: { type: String, default: '' },

  status: { type: String, enum: ['open', 'linked', 'archived'], default: 'open', index: true },
  linkedTradeId: { type: String, default: '' },

  // Manually-drawn chart markup (PDH/PDL, session highs/lows, sweeps, etc.) --
  // the levels themselves are never computed by the backend, only stored.
  chartSymbol: { type: String, default: '' },
  chartInterval: { type: String, default: '15min' },
  chartAnnotations: { type: mongoose.Schema.Types.Mixed, default: [] },
  screenshots: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('PreTradeAnalysis', preTradeAnalysisSchema);
