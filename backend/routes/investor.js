const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const TradingAccount = require('../models/TradingAccount');
const Trade = require('../models/Trade');
const { summarizeTradeResults, calculateDrawdown } = require('../lib/tradeMath');
const { getTrendbars: getCTraderTrendbars } = require('../lib/ctraderReplay');
const { requestedReplayInterval, replayWindow } = require('./trades');

const router = express.Router();

// Separate from the owner Replay cache in routes/trades.js so an investor's
// requests can never read or evict an owner's cached candles, and vice
// versa, even though both ultimately hit the same cTrader connection.
const investorReplayCache = new Map(); // { `${tradeId}:${interval}`: { ts, data } }
const REPLAY_CACHE_TTL_MS = 30 * 60 * 1000;

// Same shape as the owner-login throttle: no CAPTCHA, so cap guesses per IP.
const investorLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait 15 minutes and try again.' },
});

function investorToken(account) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(
    { userId: String(account.user), tradingAccountId: String(account._id), accountKey: account.accountKey, role: 'investor' },
    process.env.JWT_SECRET,
    { expiresIn: '30d' },
  );
}

// POST /api/investor/login  { code, password }  -- no owner session required.
router.post('/investor/login', investorLoginLimiter, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'Investor access requires MongoDB to be connected.' });
    }
    const code = String(req.body.code || '').trim();
    const password = String(req.body.password || '');
    if (!code || !password) return res.status(400).json({ error: 'Enter the account number and password.' });

    const account = await TradingAccount.findOne({ 'investor.code': code, 'investor.enabled': true });
    // Same error either way -- don't reveal whether the code exists.
    if (!account || !account.investor.passwordHash || !(await bcrypt.compare(password, account.investor.passwordHash))) {
      return res.status(401).json({ error: 'Invalid account number or password.' });
    }

    account.investor.lastViewedAt = new Date();
    await account.save();

    res.json({
      token: investorToken(account),
      account: { label: account.label, provider: account.provider, accountType: account.actualAccountType || '' },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Every investor-scoped route re-checks investor.enabled against the live
// document (not just the JWT) so disabling access from the Accounts page
// takes effect immediately, even for a token that hasn't expired yet.
async function requireLiveInvestorAccess(req, res, next) {
  if (req.user.role !== 'investor') return res.status(403).json({ error: 'Investor session required.' });
  try {
    const account = await TradingAccount.findOne({ _id: req.user.tradingAccountId, 'investor.enabled': true });
    if (!account) return res.status(401).json({ error: 'Investor access has been revoked.' });
    req.investorAccount = account;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// GET /api/investor/summary -- balance, headline stats, and equity curve for
// the one account this token is scoped to. Deliberately excludes journal
// content (notes, emotions, screenshots, checklists) -- an investor gets the
// same read-only financial picture a broker's investor password shows, not
// the trader's private notebook.
router.get('/investor/summary', auth, requireLiveInvestorAccess, async (req, res) => {
  try {
    const account = req.investorAccount;
    const trades = await Trade.find({ user: account.user, accountKey: account.accountKey }).sort({ closeTime: 1 }).lean();
    const results = summarizeTradeResults(trades);
    const drawdown = calculateDrawdown(trades);
    const lastTrade = trades[trades.length - 1];

    res.json({
      account: { label: account.label, provider: account.provider, accountType: account.actualAccountType || '' },
      balance: lastTrade ? Number(lastTrade.runningBalance || 0) : Number(account.lastBalance || 0),
      asOf: lastTrade ? lastTrade.closeTime : null,
      tradeCount: trades.length,
      netPnL: results.netPnL,
      winRate: results.winRate,
      profitFactor: results.profitFactor,
      avgWinUSD: results.avgWinUSD,
      avgLossUSD: results.avgLossUSD,
      expectancyUSD: results.expectancyUSD,
      maxDrawdownPct: drawdown.maxDrawdownPct,
      currentDrawdown: drawdown.currentDrawdown,
      equityCurve: drawdown.equityCurve,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/investor/trades -- financial fields only, newest first, capped
// and paginated the same way the owner's own trade list is.
router.get('/investor/trades', auth, requireLiveInvestorAccess, async (req, res) => {
  try {
    const account = req.investorAccount;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const [trades, total] = await Promise.all([
      Trade.find({ user: account.user, accountKey: account.accountKey })
        .sort({ closeTime: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('symbol direction entryPrice exitPrice lotSize pnlUSD pnlPct commission swap openTime closeTime durationMinutes runningBalance')
        .lean(),
      Trade.countDocuments({ user: account.user, accountKey: account.accountKey }),
    ]);

    res.json({ trades, total, page, limit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/investor/trades/:id/replay -- the same historical candles the
// owner's Trade Replay chart shows, scoped to this investor's one account
// and sanitized down to chart-safe fields only. Deliberately built as its
// own response (not a reuse of the owner /trades/:id/replay payload), which
// bundles notes/emotion/grade/tags/playbook data an investor should never see.
router.get('/investor/trades/:id/replay', auth, requireLiveInvestorAccess, async (req, res) => {
  try {
    const account = req.investorAccount;
    const trade = await Trade.findOne({ _id: req.params.id, user: account.user, accountKey: account.accountKey })
      .select('symbol direction entryPrice exitPrice openTime closeTime durationMinutes lotSize pnlUSD pnlPct accountKey')
      .lean();
    if (!trade) return res.status(404).json({ error: 'Trade not found on this account.' });

    const selectedInterval = requestedReplayInterval(req.query.interval, trade.durationMinutes);
    const cacheKey = `${req.params.id}:${selectedInterval}`;
    const cached = investorReplayCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < REPLAY_CACHE_TTL_MS) return res.json(cached.data);

    const window = replayWindow(trade, selectedInterval);
    let candleData;
    try {
      candleData = await getCTraderTrendbars({
        userId: account.user,
        symbol: trade.symbol,
        periodLabel: window.interval,
        fromMs: new Date(window.start).getTime(),
        toMs: new Date(window.end).getTime(),
        preferredCtidTraderAccountId: String(trade.accountKey || '').startsWith('ctrader:')
          ? trade.accountKey.slice('ctrader:'.length)
          : undefined,
      });
    } catch (err) {
      const setupCodes = new Set(['NOT_CONNECTED', 'NO_ACCOUNT_SELECTED']);
      const status = setupCodes.has(err.code) ? 503 : err.code === 'SYMBOL_NOT_FOUND' ? 422 : 502;
      return res.status(status).json({ error: err.message, code: err.code || 'CTRADER_ERROR' });
    }
    if (!candleData.candles.length) {
      return res.status(422).json({ error: `cTrader returned no candles for ${trade.symbol} (${window.interval}).` });
    }

    const candles = candleData.candles;
    const entryTs = Math.floor(new Date(trade.openTime).getTime() / 1000);
    const exitTs = Math.floor(new Date(trade.closeTime).getTime() / 1000);
    const candleAt = timestamp => {
      const next = candles.findIndex(c => c.time >= timestamp);
      if (next < 0) return Math.max(0, candles.length - 1);
      if (candles[next].time === timestamp || next === 0) return next;
      return next - 1;
    };

    const result = {
      candles,
      interval: selectedInterval,
      symbol: trade.symbol,
      normalizedSymbol: candleData.normalizedSymbol || candleData.brokerSymbol || trade.symbol,
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      entryTimestamp: entryTs,
      exitTimestamp: exitTs,
      entryIndex: candleAt(entryTs),
      exitIndex: candleAt(exitTs),
      pnlUSD: trade.pnlUSD,
      pnlPct: trade.pnlPct,
      lotSize: trade.lotSize,
      durationMinutes: trade.durationMinutes,
    };
    investorReplayCache.set(cacheKey, { ts: Date.now(), data: result });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
