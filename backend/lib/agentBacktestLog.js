// The Backtest Log as seen by AI agents over MCP (routes/mcp.js): read every
// logged backtest (the owner's and the agents'), edit journal fields, delete
// the agent's own trades, and compute the same statistics as the Metrics page.
//
// Trades from blind sessions never reveal their real dates or prices here --
// otherwise an agent in a blind session could look up the trade it just
// logged and learn where in history it is.
const mongoose = require('mongoose');
const BacktestTrade = require('../models/BacktestTrade');
const BacktestStrategy = require('../models/BacktestStrategy');
const { normalizeTags, strategyAndTags } = require('./backtestTags');
const { AgentError } = require('./agentReplay');

const SOURCES = ['agent', 'replay', 'quick', 'all'];
const GROUPS = ['strategy', 'symbol', 'direction', 'timeframe', 'source', 'outcome', 'weekday', 'hour', 'month'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const round = (v, digits = 3) => (v == null || !Number.isFinite(v) ? v : Number(v.toFixed(digits)) || 0); // `|| 0` turns -0 into 0
const iso = sec => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString().replace(/:00\.000Z$/, 'Z') : null);

function sourceFilter(source) {
  if (!SOURCES.includes(source)) throw new AgentError(`source must be one of ${SOURCES.join(', ')}.`);
  if (source === 'replay') return { $in: ['replay', null] }; // older trades predate the field
  return source === 'all' ? undefined : source;
}
function parseDate(value, label) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? (value > 1e11 ? value : value * 1000) : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new AgentError(`${label} must be an ISO date or a unix timestamp.`);
  return ms / 1000;
}
const tradeTime = t => (Number.isFinite(t.entryTime) ? t.entryTime : new Date(t.createdAt).getTime() / 1000);

/** Mongo query + in-memory date filter shared by list_backtests and get_metrics. */
async function findTrades(userId, { source = 'all', strategy, symbol, outcome, direction, from, to } = {}) {
  const query = { user: userId };
  const src = sourceFilter(source);
  if (src !== undefined) query.source = src;
  if (strategy) query.tags = String(strategy).trim().replace(/^#+/, '');
  if (symbol) query.symbol = String(symbol).trim().toUpperCase();
  if (outcome) {
    if (!['win', 'loss', 'breakeven'].includes(outcome)) throw new AgentError('outcome must be win, loss or breakeven.');
    query.outcome = outcome;
  }
  if (direction) {
    if (!['long', 'short'].includes(direction)) throw new AgentError('direction must be long or short.');
    query.direction = direction;
  }
  const fromSec = parseDate(from, 'from');
  const toSec = parseDate(to, 'to');
  const trades = await BacktestTrade.find(query).lean();
  const dated = fromSec != null || toSec != null;
  return trades
    // A date filter would otherwise let an agent narrow down when a blind trade happened.
    .filter(t => !dated || (!t.blind && (fromSec == null || tradeTime(t) >= fromSec) && (toSec == null || tradeTime(t) < toSec)))
    .sort((a, b) => tradeTime(a) - tradeTime(b));
}

/** A trade as agents see it; blind trades keep their results but hide time and price. */
function publicTrade(t, { full = false } = {}) {
  const hidden = Boolean(t.blind);
  const base = {
    id: String(t._id),
    name: t.name,
    strategy: t.strategy || null,
    tags: t.tags || [],
    source: t.source || 'replay',
    blind: hidden,
    symbol: t.symbol,
    timeframe: t.interval || null,
    direction: t.direction,
    outcome: t.outcome,
    rMultiple: round(t.rMultiple),
    pnlUSD: round(t.pnlUSD, 2),
    riskAmount: t.riskAmount,
    ...(hidden ? { note: 'Blind-session trade: its real dates and prices are hidden from agents.' } : {
      entryTime: iso(t.entryTime), exitTime: iso(t.exitTime),
      entryPrice: t.entryPrice ?? null, exitPrice: t.exitPrice ?? null, stopLoss: t.stopLoss ?? null, takeProfit: t.takeProfit ?? null,
    }),
    loggedAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
    planFollowed: t.planFollowed ?? null,
    setupQuality: t.setupQuality ?? 0,
    executionQuality: t.executionQuality ?? 0,
  };
  if (!full) return { ...base, hasNotes: Boolean(t.notes || t.lesson) };
  return {
    ...base,
    notes: t.notes || '',
    lesson: t.lesson || '',
    mistakes: t.mistakes || [],
    drawings: Array.isArray(t.chartAnnotations) ? t.chartAnnotations.length : 0,
  };
}

async function listBacktests(userId, input = {}) {
  const trades = await findTrades(userId, input);
  const sort = input.sort || 'newest';
  // By when it was logged, not when it happened, so blind trades don't sort into their real place in history.
  const logged = t => new Date(t.createdAt).getTime();
  const sorters = {
    newest: (a, b) => logged(b) - logged(a),
    oldest: (a, b) => logged(a) - logged(b),
    best: (a, b) => b.rMultiple - a.rMultiple,
    worst: (a, b) => a.rMultiple - b.rMultiple,
  };
  if (!sorters[sort]) throw new AgentError('sort must be newest, oldest, best or worst.');
  trades.sort(sorters[sort]);
  const limit = Math.max(1, Math.min(200, Math.floor(Number(input.limit ?? 50)) || 50));
  const offset = Math.max(0, Math.floor(Number(input.offset ?? 0)) || 0);
  return {
    total: trades.length,
    offset,
    backtests: trades.slice(offset, offset + limit).map(t => publicTrade(t)),
    ...(offset + limit < trades.length ? { next: `Pass offset: ${offset + limit} for more.` } : {}),
  };
}

async function loadTrade(userId, id, withSnapshot = false) {
  if (!mongoose.isValidObjectId(String(id || ''))) throw new AgentError('Unknown backtest id. Use list_backtests to find one.', 'NOT_FOUND');
  let q = BacktestTrade.findOne({ _id: id, user: userId });
  if (withSnapshot) q = q.select('+snapshot');
  const trade = await q.lean();
  if (!trade) throw new AgentError('Backtest not found.', 'NOT_FOUND');
  return trade;
}

/** One backtest in full, plus its chart snapshot as an image when it has one. */
async function getBacktest(userId, id, { includeSnapshot = true } = {}) {
  const trade = await loadTrade(userId, id, includeSnapshot);
  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(trade.snapshot || '');
  // A blind trade's snapshot shows real prices and dates on its axes.
  const snapshot = includeSnapshot && match && !trade.blind ? { mimeType: match[1], data: match[2] } : null;
  return { backtest: publicTrade(trade, { full: true }), snapshot };
}

/** Journal fields only; prices, times and results stay as they were logged. */
async function updateBacktest(userId, id, input = {}) {
  await loadTrade(userId, id);
  const update = {};
  if (input.name !== undefined) update.name = String(input.name || '').trim().slice(0, 100);
  if (input.tags !== undefined) Object.assign(update, strategyAndTags('', input.tags));
  else if (input.strategy !== undefined) Object.assign(update, strategyAndTags(input.strategy, []));
  if (input.notes !== undefined) update.notes = String(input.notes || '').slice(0, 5000);
  if (input.appendNotes) {
    const current = (await loadTrade(userId, id)).notes || '';
    update.notes = [update.notes ?? current, String(input.appendNotes)].filter(Boolean).join('\n\n').slice(0, 5000);
  }
  if (input.lesson !== undefined) update.lesson = String(input.lesson || '').slice(0, 2000);
  if (input.planFollowed !== undefined) update.planFollowed = typeof input.planFollowed === 'boolean' ? input.planFollowed : null;
  if (input.setupQuality !== undefined) update.setupQuality = Math.max(0, Math.min(5, Number(input.setupQuality) || 0));
  if (input.executionQuality !== undefined) update.executionQuality = Math.max(0, Math.min(5, Number(input.executionQuality) || 0));
  if (input.mistakes !== undefined) update.mistakes = normalizeTags(input.mistakes);
  if (!Object.keys(update).length) throw new AgentError('Nothing to update. Pass name, strategy, tags, notes, appendNotes, lesson, planFollowed, setupQuality, executionQuality or mistakes.');
  const trade = await BacktestTrade.findOneAndUpdate({ _id: id, user: userId }, { $set: update }, { new: true });
  return { updated: publicTrade(trade.toObject ? trade.toObject() : trade, { full: true }) };
}

/** Only trades an agent logged: the owner's own backtests are theirs to delete. */
async function deleteBacktest(userId, id) {
  const trade = await loadTrade(userId, id);
  if (trade.source !== 'agent') {
    throw new AgentError('Only backtests logged by an agent can be deleted through MCP. The owner can delete their own in the Backtest Log.', 'FORBIDDEN');
  }
  await BacktestTrade.deleteOne({ _id: id, user: userId });
  return { deleted: true, id: String(id) };
}

async function deleteStrategy(userId, name) {
  const clean = String(name || '').trim().replace(/^#+/, '');
  const result = await BacktestStrategy.deleteOne({ user: userId, name: clean });
  if (!result.deletedCount) throw new AgentError(`No strategy named "${clean}".`, 'NOT_FOUND');
  return { deleted: true, name: clean, note: 'Backtests already logged under it keep their tag.' };
}

// ── Metrics ─────────────────────────────────────────────────────────────────
/** The Metrics page's statistics (frontend/components/backtest/stats.ts), in R. */
function statsOf(trades) {
  const n = trades.length;
  const rs = trades.map(t => Number(t.rMultiple) || 0);
  const wins = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const totalR = sum(rs);
  const avgR = n ? totalR / n : 0;
  const winRs = wins.map(t => t.rMultiple), lossRs = losses.map(t => t.rMultiple);
  const grossWin = sum(rs.filter(r => r > 0)), grossLoss = -sum(rs.filter(r => r < 0));
  let equity = 0, peak = 0, maxDrawdownR = 0, winStreak = 0, lossStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  for (const t of trades) {
    equity += Number(t.rMultiple) || 0;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
    if (t.outcome === 'win') { winStreak++; lossStreak = 0; } else if (t.outcome === 'loss') { lossStreak++; winStreak = 0; } else { winStreak = 0; lossStreak = 0; }
    maxWinStreak = Math.max(maxWinStreak, winStreak);
    maxLossStreak = Math.max(maxLossStreak, lossStreak);
  }
  const std = n ? Math.sqrt(sum(rs.map(r => (r - avgR) ** 2)) / n) : 0;
  const avgWinR = winRs.length ? sum(winRs) / winRs.length : 0;
  const avgLossR = lossRs.length ? sum(lossRs) / lossRs.length : 0;
  const payoff = avgLossR < 0 ? avgWinR / -avgLossR : null;
  const w = n ? wins.length / n : 0;
  return {
    trades: n, wins: wins.length, losses: losses.length, breakevens: n - wins.length - losses.length,
    winRate: n ? round(w * 100, 1) : 0,
    avgR: round(avgR), expectancyR: round(avgR), totalR: round(totalR),
    avgWinR: round(avgWinR), avgLossR: round(avgLossR), payoffRatio: round(payoff),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    maxDrawdownR: round(maxDrawdownR),
    bestR: n ? round(Math.max(...rs)) : null, worstR: n ? round(Math.min(...rs)) : null,
    maxWinStreak, maxLossStreak,
    sqn: std > 0 ? round(Math.sqrt(n) * (avgR / std), 2) : null,
    halfKellyPct: payoff ? round(((w - (1 - w) / payoff) * 100) / 2, 1) : null,
    totalPnlUSD: round(sum(trades.map(t => Number(t.pnlUSD) || 0)), 2),
  };
}

function groupKeys(t, by) {
  const time = Number.isFinite(t.entryTime) ? t.entryTime : null;
  switch (by) {
    case 'strategy': return (t.tags && t.tags.length ? t.tags : [t.strategy || '(untagged)']);
    case 'symbol': return [t.symbol];
    case 'direction': return [t.direction];
    case 'timeframe': return [t.interval || '(none)'];
    case 'source': return [t.source || 'replay'];
    case 'outcome': return [t.outcome];
    // Weekday and hour survive blind mode (dates are shifted by whole weeks); the month doesn't.
    case 'weekday': return [time == null ? '(unknown)' : WEEKDAYS[new Date(time * 1000).getUTCDay()]];
    case 'hour': return [time == null ? '(unknown)' : `${String(new Date(time * 1000).getUTCHours()).padStart(2, '0')}:00 UTC`];
    case 'month': return [time == null ? '(unknown)' : t.blind ? '(blind)' : new Date(time * 1000).toISOString().slice(0, 7)];
    default: return [];
  }
}

async function getMetrics(userId, input = {}) {
  const source = input.source ?? 'agent';
  const trades = await findTrades(userId, { ...input, source });
  const groupBy = (Array.isArray(input.groupBy) ? input.groupBy : input.groupBy ? [input.groupBy] : ['strategy']);
  for (const g of groupBy) if (!GROUPS.includes(g)) throw new AgentError(`groupBy must be any of ${GROUPS.join(', ')}.`);
  const breakdowns = {};
  for (const by of groupBy) {
    const groups = new Map();
    for (const t of trades) for (const key of groupKeys(t, by)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    breakdowns[by] = [...groups].map(([key, list]) => ({ [by]: key, ...statsOf(list) })).sort((a, b) => b.trades - a.trades);
  }
  return { source, filters: { strategy: input.strategy ?? null, symbol: input.symbol ?? null, direction: input.direction ?? null, from: input.from ?? null, to: input.to ?? null }, overall: statsOf(trades), breakdowns };
}

module.exports = { listBacktests, getBacktest, updateBacktest, deleteBacktest, deleteStrategy, getMetrics, GROUPS };
