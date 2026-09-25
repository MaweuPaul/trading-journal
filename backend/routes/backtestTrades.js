const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const BacktestTrade = require('../models/BacktestTrade');
const auth = require('../middleware/auth');
const { getTrendbars } = require('../lib/ctraderReplay');
const { normalizePretradeAnnotations } = require('../lib/pretradeAnnotations');

function ownerOnly(req, res, next) {
  if (req.user.role === 'sync_agent') return res.status(403).json({ error: 'Owner session required.' });
  next();
}

// Backtest trades have no offline-disk store (unlike real Trades), since
// they're a nice-to-have hypothetical log, not data worth the complexity of
// an offline fallback. When MongoDB isn't connected -- readyState off, or
// the auth middleware handed out the offline placeholder user id, which
// isn't a real ObjectId and would otherwise crash every query below -- just
// say so plainly instead of leaking a raw Mongoose CastError to the UI.
function isOffline(req) {
  return mongoose.connection.readyState !== 1 || String(req.user.userId) === 'mocked_admin_user_id';
}
function offlineResponse(res) {
  return res.status(503).json({ error: 'Backtest logging needs a connected database. It is unavailable while running offline.' });
}

const CHART_INTERVALS = new Set(['1min', '5min', '15min', '1h', '4h', '1day']);
const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000; // 400 days -- cTrader still caps each response at 1500 bars regardless

// GET /backtest-trades/chart  candles for an explicit, arbitrary historical
// window -- unlike Pre-Trade Analysis's "last N days from now", a backtest
// picks any past date range to study.
router.get('/backtest-trades/chart', auth, ownerOnly, async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const interval = CHART_INTERVALS.has(String(req.query.interval || '')) ? String(req.query.interval) : '15min';
    const fromMs = Number(req.query.fromMs);
    const toMs = Number(req.query.toMs);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      return res.status(400).json({ error: 'fromMs/toMs must be a valid range' });
    }
    if (toMs - fromMs > MAX_RANGE_MS) return res.status(400).json({ error: 'That date range is too wide -- narrow it to 400 days or less.' });

    const candleData = await getTrendbars({ userId: req.user.userId, symbol, periodLabel: interval, fromMs, toMs });
    if (!candleData.candles.length) {
      return res.status(422).json({ error: `cTrader returned no candles for ${symbol} (${interval}) in that range.` });
    }
    res.json({ candles: candleData.candles, symbol, interval });
  } catch (err) {
    const setupCodes = new Set(['NOT_CONNECTED', 'NO_ACCOUNT_SELECTED']);
    const status = setupCodes.has(err.code) ? 503 : err.code === 'SYMBOL_NOT_FOUND' ? 422 : 502;
    res.status(status).json({ error: err.message, code: err.code || 'CTRADER_ERROR', setup: setupCodes.has(err.code) });
  }
});

// List the current user's backtest log. Optional symbol/direction/outcome filters.
router.get('/backtest-trades', auth, ownerOnly, async (req, res) => {
  // Nothing can have been saved offline (POST is disabled below), so the
  // honest answer to "what's logged" is an empty list, not a hard error.
  if (isOffline(req)) return res.json({ trades: [] });
  try {
    const query = { user: req.user.userId };
    if (req.query.symbol) query.symbol = String(req.query.symbol);
    if (req.query.direction) query.direction = String(req.query.direction);
    if (req.query.outcome) query.outcome = String(req.query.outcome);
    const trades = await BacktestTrade.find(query).sort({ createdAt: -1 }).lean();
    res.json({ trades });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not load backtest trades' });
  }
});

// A backtest trade is logged once it's already resolved (hit SL/TP or was
// manually closed) -- there's no draft/open state, unlike Pre-Trade Analysis.
router.post('/backtest-trades', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return offlineResponse(res);
  try {
    const {
      symbol, interval, direction, entryTime, entryPrice, exitTime, exitPrice,
      stopLoss, takeProfit, outcome, riskAmount, pnlUSD, rMultiple, notes, chartAnnotations,
    } = req.body;

    if (!symbol || typeof symbol !== 'string') return res.status(400).json({ error: 'symbol is required' });
    if (!CHART_INTERVALS.has(String(interval))) return res.status(400).json({ error: 'Unsupported interval' });
    if (!['long', 'short'].includes(direction)) return res.status(400).json({ error: 'direction must be long or short' });
    if (!['win', 'loss', 'breakeven'].includes(outcome)) return res.status(400).json({ error: 'outcome must be win, loss, or breakeven' });
    const numbers = { entryTime, entryPrice, exitTime, exitPrice, stopLoss };
    for (const [key, value] of Object.entries(numbers)) {
      if (!Number.isFinite(Number(value))) return res.status(400).json({ error: `${key} must be a number` });
    }

    let annotations = [];
    if (chartAnnotations !== undefined) {
      try {
        annotations = normalizePretradeAnnotations(chartAnnotations);
      } catch (validationErr) {
        return res.status(400).json({ error: validationErr.message });
      }
    }

    const trade = await BacktestTrade.create({
      user: req.user.userId,
      symbol: symbol.trim().slice(0, 40),
      interval: String(interval),
      direction,
      entryTime: Number(entryTime), entryPrice: Number(entryPrice),
      exitTime: Number(exitTime), exitPrice: Number(exitPrice),
      stopLoss: Number(stopLoss),
      takeProfit: takeProfit === '' || takeProfit == null ? null : Number(takeProfit),
      outcome,
      riskAmount: Number.isFinite(Number(riskAmount)) ? Number(riskAmount) : 0,
      pnlUSD: Number.isFinite(Number(pnlUSD)) ? Number(pnlUSD) : 0,
      rMultiple: Number.isFinite(Number(rMultiple)) ? Number(rMultiple) : 0,
      notes: String(notes || '').slice(0, 5000),
      chartAnnotations: annotations,
    });
    res.status(201).json(trade);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not save backtest trade' });
  }
});

router.patch('/backtest-trades/:id', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return offlineResponse(res);
  try {
    const { notes, chartAnnotations } = req.body;
    const update = {};
    if (notes !== undefined) update.notes = String(notes || '').slice(0, 5000);
    if (chartAnnotations !== undefined) {
      try {
        update.chartAnnotations = normalizePretradeAnnotations(chartAnnotations);
      } catch (validationErr) {
        return res.status(400).json({ error: validationErr.message });
      }
    }
    const trade = await BacktestTrade.findOneAndUpdate(
      { _id: req.params.id, user: req.user.userId },
      { $set: update },
      { new: true },
    );
    if (!trade) return res.status(404).json({ error: 'Backtest trade not found' });
    res.json(trade);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not update backtest trade' });
  }
});

router.delete('/backtest-trades/:id', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return offlineResponse(res);
  try {
    const result = await BacktestTrade.deleteOne({ _id: req.params.id, user: req.user.userId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Backtest trade not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not delete backtest trade' });
  }
});

module.exports = router;
