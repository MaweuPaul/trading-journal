const express = require('express');
const router = express.Router();
const PreTradeAnalysis = require('../models/PreTradeAnalysis');
const auth = require('../middleware/auth');
const { getPlaybooks } = require('./trades');

function ownerOnly(req, res, next) {
  if (req.user.role === 'sync_agent') return res.status(403).json({ error: 'Owner session required.' });
  next();
}

// List the current user's pre-trade analyses. Optional filters keep this
// usable both for "all open ones" (Trades page inherit picker) and "this
// playbook's open ones" (Playbooks page list).
router.get('/pre-trade-analyses', auth, ownerOnly, async (req, res) => {
  try {
    const query = { user: req.user.userId };
    if (req.query.playbookId) query.playbookId = String(req.query.playbookId);
    if (req.query.status) query.status = String(req.query.status);
    const analyses = await PreTradeAnalysis.find(query).sort({ createdAt: -1 }).lean();
    res.json({ analyses });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not load pre-trade analyses' });
  }
});

router.get('/pre-trade-analyses/:id', auth, ownerOnly, async (req, res) => {
  try {
    const analysis = await PreTradeAnalysis.findOne({ _id: req.params.id, user: req.user.userId }).lean();
    if (!analysis) return res.status(404).json({ error: 'Pre-trade analysis not found' });
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not load pre-trade analysis' });
  }
});

// Creates a fresh analysis locked to a playbook's latest published version --
// same "last element of versions[]" convention the rest of the app already
// uses (no version picker anywhere today).
router.post('/pre-trade-analyses', auth, ownerOnly, async (req, res) => {
  try {
    const { playbookId } = req.body;
    if (!playbookId) return res.status(400).json({ error: 'playbookId is required' });

    const playbooks = await getPlaybooks(req.user.userId);
    const playbook = playbooks.find(item => item.playbookId === String(playbookId));
    if (!playbook) return res.status(400).json({ error: 'Strategy not found' });
    const version = playbook.versions[playbook.versions.length - 1];
    if (!version) return res.status(400).json({ error: 'Strategy has no published version' });

    const playbookSnapshot = {
      playbookId: playbook.playbookId,
      name: playbook.name,
      description: playbook.description,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      schemaVersion: version.schemaVersion || 1,
      publishedAt: version.publishedAt,
      blocks: version.blocks,
    };

    const analysis = await PreTradeAnalysis.create({
      user: req.user.userId,
      playbookId: playbook.playbookId,
      playbookVersionId: version.versionId,
      playbookSnapshot,
      responses: {},
    });
    res.status(201).json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not create pre-trade analysis' });
  }
});

// A draft, not a final journal entry -- responses are stored as-is with no
// required-field validation. Real validation happens where it already does
// today, in PUT /trades/:id, once these responses are inherited into a Trade.
router.patch('/pre-trade-analyses/:id', auth, ownerOnly, async (req, res) => {
  try {
    const { responses, symbol, direction, notes, status, linkedTradeId } = req.body;
    const update = {};
    if (responses !== undefined) update.responses = responses && typeof responses === 'object' ? responses : {};
    if (symbol !== undefined) update.symbol = String(symbol || '').slice(0, 40);
    if (direction !== undefined) update.direction = ['long', 'short', ''].includes(direction) ? direction : '';
    if (notes !== undefined) update.notes = String(notes || '').slice(0, 5000);
    if (status !== undefined) update.status = ['open', 'linked', 'archived'].includes(status) ? status : 'open';
    if (linkedTradeId !== undefined) update.linkedTradeId = String(linkedTradeId || '');

    const analysis = await PreTradeAnalysis.findOneAndUpdate(
      { _id: req.params.id, user: req.user.userId },
      { $set: update },
      { new: true },
    );
    if (!analysis) return res.status(404).json({ error: 'Pre-trade analysis not found' });
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not update pre-trade analysis' });
  }
});

router.delete('/pre-trade-analyses/:id', auth, ownerOnly, async (req, res) => {
  try {
    const result = await PreTradeAnalysis.deleteOne({ _id: req.params.id, user: req.user.userId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Pre-trade analysis not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not delete pre-trade analysis' });
  }
});

module.exports = router;
