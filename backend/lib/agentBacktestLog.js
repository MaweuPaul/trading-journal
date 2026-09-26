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
const GROUPS = ['strategy', 'version', 'symbol', 'direction', 'timeframe', 'source', 'outcome', 'weekday', 'hour', 'month'];
// Plus 'feature:<name>': numeric features are split into quartiles, others grouped by value.
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
/** Strategy name -> unix seconds from which its trades are held out. */
async function holdoutsOf(userId) {
  const strategies = await BacktestStrategy.find({ user: userId, holdoutFrom: { $ne: null } }).lean();
  return new Map(strategies.filter(s => s.holdoutFrom).map(s => [s.name, new Date(s.holdoutFrom).getTime() / 1000]));
}
const versionOf = t => t.strategyVersion ?? 1;

/** Trades matching the filters, oldest first; held-out trades are removed (and counted) unless asked for. */
async function findTrades(userId, input = {}, { includeHoldout = false } = {}) {
  const { trades, heldOut } = await findTradesWithHoldout(userId, input, { includeHoldout });
  trades.heldOut = heldOut;
  return trades;
}
async function findTradesWithHoldout(userId, input, { includeHoldout }) {
  const holdouts = await holdoutsOf(userId);
  const all = await findTradesRaw(userId, input);
  const isHeld = t => (t.tags && t.tags.length ? t.tags : [t.strategy]).some(name => holdouts.has(name) && tradeTime(t) >= holdouts.get(name));
  const trades = includeHoldout ? all : all.filter(t => !isHeld(t));
  return { trades, heldOut: all.length - trades.length, isHeld };
}
function featureFilter(where) {
  if (where == null) return () => true;
  const conds = Array.isArray(where) ? where : [where];
  for (const c of conds) if (!c || typeof c.feature !== 'string') throw new AgentError('Each where condition needs a feature name, plus min/max and/or equals.');
  return t => conds.every(c => {
    const v = t.features ? t.features[c.feature] : undefined;
    if (v === undefined) return false;
    if (c.equals !== undefined && v !== c.equals) return false;
    if (c.min != null && !(typeof v === 'number' && v >= c.min)) return false;
    if (c.max != null && !(typeof v === 'number' && v <= c.max)) return false;
    return true;
  });
}
async function findTradesRaw(userId, { source = 'all', strategy, symbol, outcome, direction, from, to, where, version } = {}) {
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
  const matchesFeatures = featureFilter(where);
  return trades
    // A date filter would otherwise let an agent narrow down when a blind trade happened.
    .filter(t => !dated || (!t.blind && (fromSec == null || tradeTime(t) >= fromSec) && (toSec == null || tradeTime(t) < toSec)))
    .filter(t => version == null || versionOf(t) === Number(version))
    .filter(matchesFeatures)
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
    strategyVersion: t.strategy ? versionOf(t) : null,
    // atr14 is in real price units, which a blind trade must not reveal.
    ...(t.features ? { features: hidden ? Object.fromEntries(Object.entries(t.features).filter(([k]) => k !== 'atr14')) : t.features } : {}),
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
    ...(trades.heldOut ? { heldOut: `${trades.heldOut} trade(s) in held-out periods are hidden; use evaluate_holdout.` } : {}),
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
  const holdouts = await holdoutsOf(userId);
  if ((trade.tags || [trade.strategy]).some(name => holdouts.has(name) && tradeTime(trade) >= holdouts.get(name))) {
    throw new AgentError('This backtest is in its strategy\'s held-out period. Its result is only available in aggregate through evaluate_holdout.', 'HELD_OUT');
  }
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
    case 'version': return [t.strategy ? `${t.strategy} v${versionOf(t)}` : '(untagged)'];
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
  for (const g of groupBy) if (!GROUPS.includes(g) && !/^feature:[A-Za-z][A-Za-z0-9_]{0,39}$/.test(g)) throw new AgentError(`groupBy must be any of ${GROUPS.join(', ')}, or feature:<name>.`);
  const breakdowns = {};
  for (const by of groupBy) {
    const groups = new Map();
    const keysOf = by.startsWith('feature:') ? featureBuckets(trades, by.slice(8)) : t => groupKeys(t, by);
    for (const t of trades) for (const key of keysOf(t)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    breakdowns[by] = [...groups].map(([key, list]) => ({ [by]: key, ...statsOf(list) })).sort((a, b) => b.trades - a.trades);
  }
  return {
    source,
    filters: { strategy: input.strategy ?? null, version: input.version ?? null, symbol: input.symbol ?? null, direction: input.direction ?? null, from: input.from ?? null, to: input.to ?? null, where: input.where ?? null },
    ...(trades.heldOut ? { heldOut: `${trades.heldOut} trade(s) in held-out periods are excluded; use evaluate_holdout.` } : {}),
    overall: statsOf(trades),
    breakdowns,
  };
}

/** Group key function for a feature: quartiles for numbers, the value itself otherwise. */
function featureBuckets(trades, name) {
  const nums = trades.map(t => t.features?.[name]).filter(v => typeof v === 'number').sort((a, b) => a - b);
  const q = p => nums[Math.min(nums.length - 1, Math.floor(p * nums.length))];
  const cuts = nums.length >= 8 ? [q(0.25), q(0.5), q(0.75)] : null;
  const fmt = v => String(round(v, 4));
  return t => {
    const v = t.features?.[name];
    if (v === undefined) return ['(not recorded)'];
    if (typeof v !== 'number') return [String(v)];
    if (!cuts) return ['(too few to split)'];
    if (v <= cuts[0]) return [`Q1 ≤ ${fmt(cuts[0])}`];
    if (v <= cuts[1]) return [`Q2 ${fmt(cuts[0])}–${fmt(cuts[1])}`];
    if (v <= cuts[2]) return [`Q3 ${fmt(cuts[1])}–${fmt(cuts[2])}`];
    return [`Q4 > ${fmt(cuts[2])}`];
  };
}

// ── Strategy research: rule versions and held-out testing ───────────────────
async function loadStrategy(userId, name) {
  const clean = String(name || '').trim().replace(/^#+/, '');
  const strategy = await BacktestStrategy.findOne({ user: userId, name: clean });
  if (!strategy) throw new AgentError(`No strategy named "${clean}". Create it with create_strategy.`, 'NOT_FOUND');
  return strategy;
}
const currentVersion = s => (s.versions && s.versions.length ? s.versions[s.versions.length - 1].version : 1);
/** Versions including the implicit v1 (the description before any agent revision). */
function versionsOf(s) {
  if (s.versions && s.versions.length) return s.versions.map(v => (v.toObject ? v.toObject() : v));
  return [{ version: 1, rules: s.description || '', change: 'Initial rules', createdAt: s.createdAt, holdoutResult: null, holdoutSeenBefore: false }];
}

async function getStrategy(userId, name) {
  const s = await loadStrategy(userId, name);
  const { trades, heldOut } = await findTradesWithHoldout(userId, { source: 'agent', strategy: s.name }, { includeHoldout: false });
  return {
    name: s.name,
    currentVersion: currentVersion(s),
    rules: s.description,
    holdout: s.holdoutFrom
      ? { from: new Date(s.holdoutFrom).toISOString().slice(0, 10), evaluations: s.holdoutEvaluations || 0, heldOutTrades: heldOut,
        note: 'Trades from this date on are held out: tune rules only on earlier data, then judge a version once with evaluate_holdout.' }
      : { from: null, note: 'No held-out period yet. Set one with set_holdout before tuning rules, so improvements can be checked on data they were not fitted to.' },
    versions: versionsOf(s).map(v => ({
      version: v.version,
      change: v.change,
      createdAt: v.createdAt ? new Date(v.createdAt).toISOString().slice(0, 10) : null,
      rules: v.rules,
      inSample: statsOf(trades.filter(t => versionOf(t) === v.version)),
      holdoutResult: v.holdoutResult || null,
      ...(v.holdoutSeenBefore ? { warning: 'This version was written after held-out results had been seen, so its held-out result is not a clean test.' } : {}),
    })),
  };
}

async function updateStrategyRules(userId, { name, rules, change }) {
  const s = await loadStrategy(userId, name);
  const text = String(rules || '').trim().slice(0, 5000);
  const why = String(change || '').trim().slice(0, 1000);
  if (!text) throw new AgentError('rules is required: the full new rules, not just the change.');
  if (!why) throw new AgentError('change is required: what changed from the previous version and the evidence for it (e.g. which get_metrics breakdown).');
  if (!s.versions || !s.versions.length) s.versions = versionsOf(s);
  const version = currentVersion(s) + 1;
  s.versions.push({ version, rules: text, change: why, createdAt: new Date(), holdoutResult: null, holdoutSeenBefore: (s.holdoutEvaluations || 0) > 0 });
  s.description = text.slice(0, 500);
  await s.save();
  return {
    version,
    message: `Rules saved as version ${version}. Start a new session to trade them: trades are filed under the version in force when their session started.`,
    ...((s.holdoutEvaluations || 0) > 0 ? { warning: 'Held-out results have already been looked at, so this version\'s held-out test will be marked as not clean.' } : {}),
  };
}

async function setHoldout(userId, { name, from }) {
  const s = await loadStrategy(userId, name);
  const sec = parseDate(from, 'from');
  if (sec == null) throw new AgentError('from is required: the date from which data is held out.');
  s.holdoutFrom = new Date(sec * 1000);
  await s.save();
  return {
    name: s.name,
    holdoutFrom: s.holdoutFrom.toISOString().slice(0, 10),
    evaluationsSoFar: s.holdoutEvaluations || 0,
    message: 'Develop and tune on sessions before this date. Run the finished version on sessions after it, then call evaluate_holdout once.',
  };
}

async function evaluateHoldout(userId, { name, version }) {
  const s = await loadStrategy(userId, name);
  if (!s.holdoutFrom) throw new AgentError('This strategy has no held-out period. Set one with set_holdout first.');
  const v = version == null ? currentVersion(s) : Number(version);
  const { trades, isHeld } = await findTradesWithHoldout(userId, { source: 'agent', strategy: s.name, version: v }, { includeHoldout: true });
  const outOfSample = trades.filter(isHeld), inSample = trades.filter(t => !isHeld(t));
  const inStats = statsOf(inSample), outStats = statsOf(outOfSample);
  let verdict;
  if (outStats.trades < 20) verdict = `Only ${outStats.trades} held-out trade(s): too few to judge. Run more sessions after ${new Date(s.holdoutFrom).toISOString().slice(0, 10)} with this version.`;
  else if (outStats.avgR <= 0) verdict = 'Fails out of sample: the held-out average R is zero or negative.';
  else if (inStats.trades && outStats.avgR < inStats.avgR / 2) verdict = 'Weaker out of sample: positive, but less than half the in-sample average R. Likely partly overfitted.';
  else verdict = 'Holds up out of sample.';

  if (!s.versions || !s.versions.length) s.versions = versionsOf(s);
  const entry = s.versions.find(x => x.version === v);
  const result = { evaluatedAt: new Date().toISOString(), inSample: inStats, outOfSample: outStats, verdict };
  if (entry && !entry.holdoutResult) entry.holdoutResult = result; // the first look is the one that counts
  s.holdoutEvaluations = (s.holdoutEvaluations || 0) + 1;
  s.markModified('versions');
  await s.save();
  return {
    name: s.name, version: v, ...result,
    evaluations: s.holdoutEvaluations,
    ...(s.holdoutEvaluations > 3 ? { warning: `The held-out data has now been looked at ${s.holdoutEvaluations} times. Each look makes it less independent; for a clean test, hold out a newer period.` } : {}),
    ...(entry && entry.holdoutSeenBefore ? { note: 'This version was written after held-out results had been seen, so this is not a clean test.' } : {}),
  };
}

module.exports = {
  listBacktests, getBacktest, updateBacktest, deleteBacktest, deleteStrategy, getMetrics, GROUPS,
  getStrategy, updateStrategyRules, setHoldout, evaluateHoldout,
};
