const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const BacktestTrade = require('../models/BacktestTrade');
const auth = require('../middleware/auth');
const { getTrendbars } = require('../lib/ctraderReplay');
const { normalizeBacktestDrawings } = require('../lib/backtestDrawings');

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

// Strategy tags: "#ICT-SilverBullet" and "ICT-SilverBullet" are the same tag.
// Up to 10 per trade, de-duplicated case-insensitively, first one wins.
function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const tags = [];
  for (const raw of input) {
    const tag = String(raw || '').trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 40);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 10) break;
  }
  return tags;
}
// Keep `strategy` (primary) and `tags` consistent: strategy is always tags[0].
function strategyAndTags(strategy, tags) {
  const normalized = normalizeTags(tags);
  const primary = String(strategy || '').trim().slice(0, 80);
  if (!normalized.length && primary) normalized.push(primary);
  return { strategy: normalized[0] || '', tags: normalized };
}

const MAX_SNAPSHOT_CHARS = 400_000; // ~300 KB JPEG
function normalizeSnapshot(value) {
  if (typeof value !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(value)) return '';
  return value.length <= MAX_SNAPSHOT_CHARS ? value : '';
}

const CHART_INTERVALS = new Set(['1min', '5min', '15min', '1h', '4h', '1day']);
// cTrader caps each GET_TRENDBARS_REQ response at 1500 bars (ctraderReplay.js),
// regardless of how wide a fromTimestamp/toTimestamp window is requested. A
// flat day-count cap doesn't fit every timeframe -- 400 days of 1min bars is
// already ~576,000 bars (way over), while 400 days of 1day bars is only 400
// bars (way under). Scale the cap to the chosen interval instead, so a daily
// chart can go back years and a 1-minute chart is kept to what cTrader can
// actually return in one request.
const INTERVAL_MS = { '1min': 60e3, '5min': 300e3, '15min': 900e3, '1h': 3600e3, '4h': 14400e3, '1day': 86400e3 };
function maxRangeMsFor(interval) {
  return (INTERVAL_MS[interval] || INTERVAL_MS['15min']) * 1500;
}

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
    const maxRangeMs = maxRangeMsFor(interval);
    if (toMs - fromMs > maxRangeMs) {
      const maxDays = Math.floor(maxRangeMs / 86400000);
      return res.status(400).json({ error: `That date range is too wide for ${interval} candles -- narrow it to ${maxDays} days or less, or pick a larger timeframe.` });
    }

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

// List the current user's backtest log. Optional symbol/direction/outcome/strategy filters.
router.get('/backtest-trades', auth, ownerOnly, async (req, res) => {
  // Nothing can have been saved offline (POST is disabled below), so the
  // honest answer to "what's logged" is an empty list, not a hard error.
  if (isOffline(req)) return res.json({ trades: [] });
  try {
    const query = { user: req.user.userId };
    if (req.query.symbol) query.symbol = String(req.query.symbol);
    if (req.query.direction) query.direction = String(req.query.direction);
    if (req.query.outcome) query.outcome = String(req.query.outcome);
    if (req.query.strategy) query.strategy = String(req.query.strategy);
    if (req.query.tag) query.tags = String(req.query.tag);
    const trades = await BacktestTrade.find(query).sort({ createdAt: -1 }).lean();
    // Flag which trades have a snapshot without shipping every image in the list.
    const withSnapshot = new Set((await BacktestTrade.find({ ...query, snapshot: { $nin: ['', null] } }).select('_id').lean()).map(t => String(t._id)));
    res.json({ trades: trades.map(t => ({ ...t, hasSnapshot: withSnapshot.has(String(t._id)) })) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not load backtest trades' });
  }
});

// Distinct strategy names this user has already used, so the Backtest chart
// can offer them as a searchable dropdown -- picking an existing one keeps
// metrics comparable across backtests of the same strategy; typing a new
// name creates it implicitly the first time it's saved.
router.get('/backtest-trades/strategies', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return res.json({ strategies: [] });
  try {
    const [strategies, tags] = await Promise.all([
      BacktestTrade.distinct('strategy', { user: req.user.userId, strategy: { $ne: '' } }),
      BacktestTrade.distinct('tags', { user: req.user.userId }),
    ]);
    const merged = normalizeTags([...tags, ...strategies]);
    res.json({ strategies: merged.sort((a, b) => a.localeCompare(b)) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not load strategies' });
  }
});

// A backtest trade is logged once it's already resolved (hit SL/TP or was
// manually closed) -- there's no draft/open state, unlike Pre-Trade Analysis.
router.post('/backtest-trades', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return offlineResponse(res);
  try {
    const {
      name, strategy, tags, source, symbol, interval, direction, entryTime, entryPrice, exitTime, exitPrice,
      stopLoss, takeProfit, outcome, riskAmount, pnlUSD, rMultiple, notes, chartAnnotations, snapshot,
    } = req.body;
    // Quick logs (from the Backtest Log's "New Backtest" form) carry only a
    // label, symbol, direction, P&L and R -- no chart, prices or times.
    const isQuick = source === 'quick';

    if (!symbol || typeof symbol !== 'string') return res.status(400).json({ error: 'symbol is required' });
    if (!isQuick && !CHART_INTERVALS.has(String(interval))) return res.status(400).json({ error: 'Unsupported interval' });
    if (!['long', 'short'].includes(direction)) return res.status(400).json({ error: 'direction must be long or short' });
    if (!['win', 'loss', 'breakeven'].includes(outcome)) return res.status(400).json({ error: 'outcome must be win, loss, or breakeven' });
    if (isQuick) {
      if (!Number.isFinite(Number(rMultiple))) return res.status(400).json({ error: 'rMultiple must be a number' });
    } else {
      const numbers = { entryTime, entryPrice, exitTime, exitPrice, stopLoss };
      for (const [key, value] of Object.entries(numbers)) {
        if (!Number.isFinite(Number(value))) return res.status(400).json({ error: `${key} must be a number` });
      }
    }
    const optionalNumber = value => (value === '' || value == null || !Number.isFinite(Number(value)) ? undefined : Number(value));

    let annotations = [];
    if (chartAnnotations !== undefined) {
      try {
        annotations = normalizeBacktestDrawings(chartAnnotations);
      } catch (validationErr) {
        return res.status(400).json({ error: validationErr.message });
      }
    }

    const trade = await BacktestTrade.create({
      user: req.user.userId,
      name: String(name || '').trim().slice(0, 100),
      ...strategyAndTags(strategy, tags),
      source: isQuick ? 'quick' : 'replay',
      symbol: symbol.trim().toUpperCase().slice(0, 40),
      interval: CHART_INTERVALS.has(String(interval)) ? String(interval) : '',
      direction,
      entryTime: optionalNumber(entryTime), entryPrice: optionalNumber(entryPrice),
      exitTime: optionalNumber(exitTime), exitPrice: optionalNumber(exitPrice),
      stopLoss: optionalNumber(stopLoss),
      takeProfit: takeProfit === '' || takeProfit == null ? null : Number(takeProfit),
      outcome,
      riskAmount: Number.isFinite(Number(riskAmount)) ? Number(riskAmount) : 0,
      pnlUSD: Number.isFinite(Number(pnlUSD)) ? Number(pnlUSD) : 0,
      rMultiple: Number.isFinite(Number(rMultiple)) ? Number(rMultiple) : 0,
      notes: String(notes || '').slice(0, 5000),
      chartAnnotations: annotations,
      snapshot: normalizeSnapshot(snapshot),
    });
    const saved = trade.toObject();
    saved.hasSnapshot = Boolean(saved.snapshot);
    delete saved.snapshot;
    res.status(201).json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not save backtest trade' });
  }
});

router.get('/backtest-trades/:id/snapshot', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return offlineResponse(res);
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Backtest trade not found' });
    const trade = await BacktestTrade.findOne({ _id: req.params.id, user: req.user.userId }).select('+snapshot').lean();
    if (!trade) return res.status(404).json({ error: 'Backtest trade not found' });
    res.json({ snapshot: trade.snapshot || '' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not load snapshot' });
  }
});

router.patch('/backtest-trades/:id', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return offlineResponse(res);
  try {
    const { name, strategy, tags, notes, chartAnnotations } = req.body;
    const update = {};
    if (name !== undefined) update.name = String(name || '').trim().slice(0, 100);
    if (tags !== undefined) Object.assign(update, strategyAndTags('', tags));
    else if (strategy !== undefined) Object.assign(update, strategyAndTags(strategy, []));
    if (notes !== undefined) update.notes = String(notes || '').slice(0, 5000);
    if (chartAnnotations !== undefined) {
      try {
        update.chartAnnotations = normalizeBacktestDrawings(chartAnnotations);
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
