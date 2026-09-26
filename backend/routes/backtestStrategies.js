const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const BacktestStrategy = require('../models/BacktestStrategy');
const BacktestTrade = require('../models/BacktestTrade');
const auth = require('../middleware/auth');

function ownerOnly(req, res, next) {
  if (req.user.role === 'sync_agent') return res.status(403).json({ error: 'Owner session required.' });
  next();
}
function isOffline(req) {
  return mongoose.connection.readyState !== 1 || String(req.user.userId) === 'mocked_admin_user_id';
}
function offlineResponse(res) {
  return res.status(503).json({ error: 'Strategies need a connected database. Unavailable while running offline.' });
}

// List the user's strategies, each with a live trade count/win rate/avg R
// computed from BacktestTrade -- so a strategy shows real numbers the
// moment it has any trades logged against it, with zero extra bookkeeping
// to keep in sync.
router.get('/backtest-strategies', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return res.json({ strategies: [] });
  try {
    const strategies = await BacktestStrategy.find({ user: req.user.userId }).sort({ name: 1 }).lean();
    const stats = await BacktestTrade.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(req.user.userId), strategy: { $ne: '' } } },
      // Trades logged by AI agents (MCP) are counted separately, so they never
      // move the owner's own numbers for a strategy.
      { $group: {
        _id: { strategy: '$strategy', agent: { $eq: ['$source', 'agent'] } },
        trades: { $sum: 1 }, wins: { $sum: { $cond: [{ $eq: ['$outcome', 'win'] }, 1, 0] } }, totalR: { $sum: '$rMultiple' },
      } },
    ]);
    const own = new Map(stats.filter(s => !s._id.agent).map(s => [s._id.strategy, s]));
    const agent = new Map(stats.filter(s => s._id.agent).map(s => [s._id.strategy, s]));
    const statsFor = name => {
      const stat = own.get(name), agentStat = agent.get(name);
      return {
        trades: stat?.trades ?? 0,
        winRate: stat?.trades ? (stat.wins / stat.trades) * 100 : 0,
        avgR: stat?.trades ? stat.totalR / stat.trades : 0,
        agentTrades: agentStat?.trades ?? 0,
        agentWinRate: agentStat?.trades ? (agentStat.wins / agentStat.trades) * 100 : 0,
        agentAvgR: agentStat?.trades ? agentStat.totalR / agentStat.trades : 0,
      };
    };
    const merged = strategies.map(s => ({ ...s, ...statsFor(s.name) }));
    // Strategies that only exist as trade tags (created the old way, before
    // this endpoint existed) still show up, just without a description.
    for (const name of new Set(stats.map(s => s._id.strategy))) {
      if (!strategies.some(s => s.name === name)) merged.push({ _id: name, name, description: '', ...statsFor(name) });
    }
    merged.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ strategies: merged });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not load strategies' });
  }
});

router.post('/backtest-strategies', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return offlineResponse(res);
  try {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Strategy name is required' });
    const description = String(req.body.description || '').trim().slice(0, 500);
    const strategy = await BacktestStrategy.findOneAndUpdate(
      { user: req.user.userId, name },
      { $setOnInsert: { user: req.user.userId, name }, $set: { description } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.status(201).json(strategy);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A strategy with that name already exists' });
    res.status(500).json({ error: err.message || 'Could not create strategy' });
  }
});

router.delete('/backtest-strategies/:id', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return offlineResponse(res);
  try {
    const result = await BacktestStrategy.deleteOne({ _id: req.params.id, user: req.user.userId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Strategy not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not delete strategy' });
  }
});

module.exports = router;
