const express = require('express');
const router = express.Router();
const { v2: cloudinary } = require('cloudinary');
const PreTradeAnalysis = require('../models/PreTradeAnalysis');
const auth = require('../middleware/auth');
const { getPlaybooks } = require('./trades');
const { getTrendbars, listAccountSymbols } = require('../lib/ctraderReplay');
const { normalizePretradeAnnotations } = require('../lib/pretradeAnnotations');

function ownerOnly(req, res, next) {
  if (req.user.role === 'sync_agent') return res.status(403).json({ error: 'Owner session required.' });
  next();
}

const CHART_INTERVALS = new Set(['1min', '5min', '15min', '1h', '4h', '1day']);

// GET /pre-trade-analyses/chart  candles for an arbitrary symbol -- no Trade
// required, unlike Trade Replay's /trades/:id/replay. The user marks levels
// themselves; this route only supplies the raw candles to draw on.
router.get('/pre-trade-analyses/chart', auth, ownerOnly, async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const interval = CHART_INTERVALS.has(String(req.query.interval || '')) ? String(req.query.interval) : '15min';
    const days = Math.max(1, Math.min(30, Number(req.query.days) || 5));
    const toMs = Date.now();
    const fromMs = toMs - days * 24 * 60 * 60 * 1000;

    const candleData = await getTrendbars({ userId: req.user.userId, symbol, periodLabel: interval, fromMs, toMs });
    if (!candleData.candles.length) {
      return res.status(422).json({ error: `cTrader returned no candles for ${symbol} (${interval}).` });
    }
    res.json({ candles: candleData.candles, symbol, interval, days });
  } catch (err) {
    const setupCodes = new Set(['NOT_CONNECTED', 'NO_ACCOUNT_SELECTED']);
    const status = setupCodes.has(err.code) ? 503 : err.code === 'SYMBOL_NOT_FOUND' ? 422 : 502;
    res.status(status).json({ error: err.message, code: err.code || 'CTRADER_ERROR', setup: setupCodes.has(err.code) });
  }
});

// GET /pre-trade-analyses/symbols  the connected account's actual tradable
// symbol names, so the chart's symbol field can offer real spellings instead
// of the user guessing a broker-specific name (a datalist, not a required
// selection -- typing something not in this list still works).
router.get('/pre-trade-analyses/symbols', auth, ownerOnly, async (req, res) => {
  try {
    const symbols = await listAccountSymbols({ userId: req.user.userId });
    res.json({ symbols });
  } catch (err) {
    const setupCodes = new Set(['NOT_CONNECTED', 'NO_ACCOUNT_SELECTED']);
    const status = setupCodes.has(err.code) ? 503 : 502;
    res.status(status).json({ error: err.message, code: err.code || 'CTRADER_ERROR' });
  }
});

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
    const { responses, symbol, direction, notes, status, linkedTradeId, chartSymbol, chartInterval, chartAnnotations } = req.body;
    const update = {};
    if (responses !== undefined) update.responses = responses && typeof responses === 'object' ? responses : {};
    if (symbol !== undefined) update.symbol = String(symbol || '').slice(0, 40);
    if (direction !== undefined) update.direction = ['long', 'short', ''].includes(direction) ? direction : '';
    if (notes !== undefined) update.notes = String(notes || '').slice(0, 5000);
    if (status !== undefined) update.status = ['open', 'linked', 'archived'].includes(status) ? status : 'open';
    if (linkedTradeId !== undefined) update.linkedTradeId = String(linkedTradeId || '');
    if (chartSymbol !== undefined) update.chartSymbol = String(chartSymbol || '').slice(0, 40);
    if (chartInterval !== undefined) update.chartInterval = CHART_INTERVALS.has(String(chartInterval)) ? String(chartInterval) : '15min';
    if (chartAnnotations !== undefined) {
      try {
        update.chartAnnotations = normalizePretradeAnnotations(chartAnnotations);
      } catch (validationErr) {
        return res.status(400).json({ error: validationErr.message });
      }
    }

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

// POST /pre-trade-analyses/:id/screenshots  upload a chart image annotation.
// Simpler than the Trade equivalent (trades.js POST /trades/:id/screenshots):
// no offline-disk fallback, since PreTradeAnalysis has no offline store.
router.post('/pre-trade-analyses/:id/screenshots', auth, ownerOnly, async (req, res) => {
  try {
    const { imageData, caption = '' } = req.body;
    if (!imageData || typeof imageData !== 'string' || !imageData.startsWith('data:image/')) {
      return res.status(400).json({ error: 'imageData must be a base64 data URL image.' });
    }
    const analysis = await PreTradeAnalysis.findOne({ _id: req.params.id, user: req.user.userId });
    if (!analysis) return res.status(404).json({ error: 'Pre-trade analysis not found' });

    const upload = await cloudinary.uploader.upload(imageData, {
      folder: `pretrade-analyses/${req.user.userId}/${analysis._id}`,
      resource_type: 'image',
      overwrite: false,
    });

    analysis.screenshots.push({
      url: upload.secure_url,
      publicId: upload.public_id,
      caption: String(caption).trim().slice(0, 180),
      uploadedAt: new Date(),
    });
    await analysis.save();
    res.json({ screenshots: analysis.screenshots });
  } catch (err) {
    console.error('Pre-trade screenshot upload error:', err.message);
    res.status(500).json({ error: err.message || 'Could not upload chart image' });
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
