const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const TradingAccount = require('../models/TradingAccount');
const Trade = require('../models/Trade');
const { summarizeTradeResults, calculateDrawdown } = require('../lib/tradeMath');

const router = express.Router();

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
    const trades = await Trade.find({ accountKey: account.accountKey }).sort({ closeTime: 1 }).lean();
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
      Trade.find({ accountKey: account.accountKey })
        .sort({ closeTime: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('symbol direction entryPrice exitPrice lotSize pnlUSD pnlPct commission swap openTime closeTime durationMinutes runningBalance')
        .lean(),
      Trade.countDocuments({ accountKey: account.accountKey }),
    ]);

    res.json({ trades, total, page, limit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
