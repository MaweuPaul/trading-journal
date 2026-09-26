// Server-side bar-by-bar replay for AI agents (the MCP tools in routes/mcp.js).
//
// The replay clock lives in AgentReplaySession, and every candle handed to an
// agent is checked against it: nothing whose close time (time + timeframe) is
// after the clock ever leaves this module. That is the same no-hindsight rule
// the Backtest chart enforces in the browser (frontend/components/backtest/
// Workspace.tsx), including how a candle that spans both the stop and the
// target is settled on smaller candles.
//
// Blind sessions go one step further: the agent is never told where in
// history it is. Times are shifted by whole weeks and prices scaled by a
// random factor on the way out, and agent-supplied prices/times are mapped
// back on the way in. Stored data always stays in real time and real prices.
const mongoose = require('mongoose');
const AgentReplaySession = require('../models/AgentReplaySession');
const BacktestTrade = require('../models/BacktestTrade');
const BacktestStrategy = require('../models/BacktestStrategy');
const { getTrendbars, listAccountSymbols } = require('./ctraderReplay');
const { normalizeTags, strategyAndTags } = require('./backtestTags');

const TF_SEC = { '1min': 60, '5min': 300, '15min': 900, '1h': 3600, '4h': 14400, '1day': 86400 };
const INTERVALS = Object.keys(TF_SEC);
const FINER = { '1day': '4h', '4h': '1h', '1h': '15min', '15min': '5min', '5min': '1min' };
const DAY = 86400;
const WEEK = 7 * DAY;

const SESSION_TTL_MS = 7 * DAY * 1000;
const MAX_ACTIVE_SESSIONS = 10;       // per user
const MAX_CANDLES_PER_CALL = 500;     // get_candles / start_session context
const MAX_STEP_BARS = 5000;
const RETURNED_STEP_CANDLES = 200;
const MAX_SESSION_DAYS = 5 * 365;
const MAX_BLIND_DAYS = 365;
// cTrader throttles historical-data requests per connection, so each user's
// fetches run one at a time and are capped per minute across all their agents.
// Override with AGENT_CTRADER_FETCHES_PER_MINUTE. Each fetch is at most ~14
// cTrader requests (a 20,000-bar window), and candles arrive in 3,000-bar
// blocks, so most replay steps never fetch at all.
const FETCHES_PER_MINUTE = positiveInt(process.env.AGENT_CTRADER_FETCHES_PER_MINUTE, 120);
// Each getTrendbars call covers at most this many bars (cTrader pages 1500 at a
// time; getTrendbars stops at 14 pages).
const FETCH_CHUNK_BARS = 20000;
// Gaps are widened to whole blocks of this many bars, so the small windows a
// replay asks for one after another (and the finer candles used to settle a
// stop-vs-target candle) are mostly served from one earlier fetch.
const FETCH_BLOCK_BARS = 3000;
// Rough memory ceiling for the in-process candle cache (~100 bytes a candle).
const MAX_CACHED_CANDLES = 600_000;
// Blind sessions are shifted so they start in the first week of 1990 (a Monday).
const BLIND_EPOCH = 631152000;

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

class AgentError extends Error {
  constructor(message, code = 'BAD_REQUEST') { super(message); this.code = code; }
}

// ── Candle cache ────────────────────────────────────────────────────────────
// Per process, keyed user|symbol|timeframe, mirroring the browser's
// candleCache.ts: history never changes, so only gaps in the covered ranges
// are fetched. Ranges are [from, to) in unix seconds on candle open time.
const cache = new Map();
let cachedCandleCount = 0;

function cacheEntry(key) {
  let entry = cache.get(key);
  if (entry) cache.delete(key); // re-insert so Map order is least-recently-used first
  else entry = { candles: [], ranges: [] };
  cache.set(key, entry);
  return entry;
}
function evictCache(keep) {
  for (const [key, entry] of cache) {
    if (cachedCandleCount <= MAX_CACHED_CANDLES) break;
    if (entry === keep) continue;
    cachedCandleCount -= entry.candles.length;
    cache.delete(key);
  }
}

/** Parts of [from, to) not yet covered by `ranges`. */
function missingRanges(ranges, from, to) {
  const gaps = [];
  let cursor = from;
  for (const [a, b] of ranges) {
    if (b <= cursor) continue;
    if (a >= to) break;
    if (a > cursor) gaps.push([cursor, Math.min(a, to)]);
    cursor = Math.max(cursor, b);
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push([cursor, to]);
  return gaps;
}
/** Insert [from, to) and merge touching/overlapping ranges. */
function addRange(ranges, from, to) {
  const all = [...ranges, [from, to]].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
/** Merge two time-sorted candle lists, newer data winning on equal times. */
function mergeCandles(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const ta = i < a.length ? a[i].time : Infinity, tb = j < b.length ? b[j].time : Infinity;
    if (ta < tb) out.push(a[i++]);
    else if (tb < ta) out.push(b[j++]);
    else { out.push(b[j++]); i++; }
  }
  return out;
}
/** First index with time >= t. */
function lowerBound(candles, t) {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].time < t) lo = mid + 1; else hi = mid; }
  return lo;
}

const fetchQueues = new Map(); // userId -> { chain, stamps }
function throttledFetch(userId, fn) {
  const key = String(userId);
  let queue = fetchQueues.get(key);
  if (!queue) { queue = { chain: Promise.resolve(), stamps: [] }; fetchQueues.set(key, queue); }
  const run = queue.chain.then(() => {
    const now = Date.now();
    queue.stamps = queue.stamps.filter(t => now - t < 60_000);
    if (queue.stamps.length >= FETCHES_PER_MINUTE) {
      throw new AgentError('Too many cTrader candle requests in the last minute across your agent sessions. Wait about a minute and try again, or step through less new history per call.', 'RATE_LIMITED');
    }
    queue.stamps.push(now);
    return fn();
  });
  queue.chain = run.catch(() => {});
  return run;
}

/** Candles of `tf` with open time in [from, to), fetching only uncached gaps. */
async function candlesIn(ctx, tf, from, to) {
  from = Math.floor(from); to = Math.ceil(to);
  if (to <= from) return [];
  const sec = TF_SEC[tf];
  const entry = cacheEntry(`${ctx.userId}|${ctx.symbol}|${tf}`);
  // Never treat the still-forming tail as settled history.
  const settledUntil = Math.floor(Date.now() / 1000) - 2 * sec;
  const block = FETCH_BLOCK_BARS * sec;
  const wanted = missingRanges(entry.ranges, from, to)
    .reduce((ranges, [a, b]) => addRange(ranges, Math.floor(a / block) * block, Math.ceil(b / block) * block), []);
  for (const [wa, wb] of wanted) for (const [a, b] of missingRanges(entry.ranges, wa, wb)) {
    for (let start = a; start < b; start += FETCH_CHUNK_BARS * sec) {
      const end = Math.min(b, start + FETCH_CHUNK_BARS * sec);
      const { candles } = await throttledFetch(ctx.userId, () => getTrendbars({
        userId: ctx.userId, symbol: ctx.symbol, periodLabel: tf, fromMs: start * 1000, toMs: end * 1000, maxPages: 15,
      }));
      const before = entry.candles.length;
      entry.candles = mergeCandles(entry.candles, candles.filter(c => c.time >= start && c.time < end));
      cachedCandleCount += entry.candles.length - before;
      const coveredTo = Math.min(end, settledUntil);
      if (coveredTo > start) entry.ranges = addRange(entry.ranges, start, coveredTo);
    }
  }
  evictCache(entry);
  return entry.candles.slice(lowerBound(entry.candles, from), lowerBound(entry.candles, to));
}

/** The last `count` candles of `tf` that closed at or before `end`. */
async function closedCandles(ctx, tf, end, count) {
  const sec = TF_SEC[tf];
  // Weekends and holidays mean N bars span more than N * sec; widen until enough.
  let span = count * sec * 2 + 3 * DAY;
  const maxSpan = count * sec * 4 + 30 * DAY;
  for (;;) {
    const got = (await candlesIn(ctx, tf, end - span, end)).filter(c => c.time + sec <= end);
    if (got.length >= count || span >= maxSpan) return got.slice(-count);
    span = Math.min(maxSpan, span * 2);
  }
}

/**
 * The next `count` candles of `tf` still to be revealed after `clock` (close
 * time > clock), opening before `endSec`. The first one may have opened before
 * the clock if the timeframe was switched mid-candle.
 */
async function nextCandles(ctx, tf, clock, count, endSec) {
  const sec = TF_SEC[tf];
  let span = count * sec * 2 + 3 * DAY;
  const maxSpan = count * sec * 4 + 30 * DAY;
  for (;;) {
    const to = Math.min(endSec, clock + span);
    const got = (await candlesIn(ctx, tf, clock - sec, to)).filter(c => c.time + sec > clock);
    if (got.length >= count || to >= endSec || span >= maxSpan) return { candles: got.slice(0, count), reachedEnd: to >= endSec };
    span = Math.min(maxSpan, span * 2);
  }
}

// ── Trade resolution ────────────────────────────────────────────────────────
function levelsHit(c, t) {
  const long = t.direction === 'long';
  return {
    sl: long ? c.low <= t.stopLoss : c.high >= t.stopLoss,
    tp: t.takeProfit != null && (long ? c.high >= t.takeProfit : c.low <= t.takeProfit),
  };
}

/**
 * Which level was reached first inside [start, end), using `tf` candles and
 * walking down to smaller ones while a candle spans both levels or reaches
 * outside the window. null when neither was reached. If even 1-minute candles
 * can't separate the two, the stop is assumed (the conservative reading).
 */
async function firstHit(ctx, tf, start, end, t) {
  const sec = TF_SEC[tf];
  const parts = await candlesIn(ctx, tf, start - sec + 1, end);
  for (const p of parts) {
    const pEnd = p.time + sec;
    if (pEnd <= start || p.time >= end) continue;
    const h = levelsHit(p, t);
    if (!h.sl && !h.tp) continue;
    const straddles = p.time < start || pEnd > end;
    if (!straddles && !(h.sl && h.tp)) return h.sl ? 'sl' : 'tp';
    const finer = FINER[tf];
    if (finer) {
      const which = await firstHit(ctx, finer, Math.max(start, p.time), Math.min(end, pEnd), t);
      if (which) return which;
      if (straddles) continue; // the hit was outside the window
      return 'sl';            // no finer data to separate them
    }
    return h.sl ? 'sl' : 'tp';
  }
  return null;
}

function closedTradeFrom(trade, which, exitTime, exitPriceOverride) {
  const exitPrice = exitPriceOverride ?? (which === 'sl' ? trade.stopLoss : trade.takeProfit);
  const rMultiple = rMultipleOf(trade, exitPrice);
  return { ...trade, exitTime, exitPrice, exitReason: which === 'sl' ? 'stop' : 'target', outcome: outcomeOf(rMultiple, which === 'tp'), rMultiple, pnlUSD: rMultiple * trade.riskAmount };
}
// A stop that was moved to entry is breakeven; one moved past entry locks in a
// win. The tolerance absorbs rounding: agents see prices rounded (or rescaled
// in blind sessions), so "stop to entry" can land a hair away from it.
const BREAKEVEN_R = 0.001;
function outcomeOf(rMultiple, hitTarget = false) {
  if (hitTarget) return 'win';
  return Math.abs(rMultiple) < BREAKEVEN_R ? 'breakeven' : rMultiple > 0 ? 'win' : 'loss';
}
/** R against the stop the trade was opened with, even if the stop was moved since. */
function rMultipleOf(trade, price) {
  const stop = trade.initialStopLoss ?? trade.stopLoss;
  const risk = trade.direction === 'long' ? trade.entryPrice - stop : stop - trade.entryPrice;
  const gain = trade.direction === 'long' ? price - trade.entryPrice : trade.entryPrice - price;
  return risk !== 0 ? gain / risk : 0;
}

// ── Output (and blind-mode transforms) ──────────────────────────────────────
const round = (v, digits = 3) => (v == null || !Number.isFinite(v) ? v : Number(v.toFixed(digits)) || 0); // `|| 0` turns -0 into 0
const plain = doc => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

function viewOf(s) {
  const b = s.blind && s.blind.enabled ? s.blind : null;
  const shift = b ? b.timeShift : 0;
  const scale = b ? b.priceScale : 1;
  const iso = sec => new Date((sec - shift) * 1000).toISOString().replace(/:00\.000Z$/, 'Z').replace(/\.000Z$/, 'Z');
  // cTrader prices have 5 decimals; scaled (blind) ones keep 8 significant digits.
  const px = v => (v == null ? v : b ? Number((v * scale).toPrecision(8)) : Number(v.toFixed(5)));
  const viewFeatures = f => (f.atr14 != null ? { ...f, atr14: px(f.atr14) } : f);
  return {
    blind: Boolean(b),
    iso,
    px,
    priceIn: v => (v == null ? v : v / scale),
    timeIn: sec => sec + shift,
    candle: c => ({ time: iso(c.time), open: px(c.open), high: px(c.high), low: px(c.low), close: px(c.close), volume: c.volume, ...(c.forming ? { forming: true } : {}) }),
    trade: raw => {
      const t = plain(raw);
      if (!t) return null;
      return {
        direction: t.direction, entryTime: iso(t.entryTime), entryPrice: px(t.entryPrice), stopLoss: px(t.stopLoss),
        ...(t.initialStopLoss != null && t.initialStopLoss !== t.stopLoss ? { initialStopLoss: px(t.initialStopLoss) } : {}),
        takeProfit: px(t.takeProfit), riskAmount: t.riskAmount,
        ...(t.features ? { features: viewFeatures(t.features) } : {}),
        ...(t.exitTime != null ? {
          exitTime: iso(t.exitTime), exitPrice: px(t.exitPrice), exitReason: t.exitReason, outcome: t.outcome,
          rMultiple: round(t.rMultiple), pnlUSD: round(t.pnlUSD, 2),
        } : {}),
      };
    },
    order: raw => {
      const o = plain(raw);
      if (!o) return null;
      return {
        type: o.type, direction: o.direction, price: px(o.price), stopLoss: px(o.stopLoss), takeProfit: px(o.takeProfit),
        riskAmount: o.riskAmount, placedAt: iso(o.placedAt), expiresAt: o.expiresAt == null ? null : iso(o.expiresAt),
        ...(o.features ? { features: viewFeatures(o.features) } : {}),
      };
    },
  };
}

function parseTime(value, label) {
  if (value == null || value === '') return null;
  let ms;
  if (typeof value === 'number') ms = value > 1e11 ? value : value * 1000;
  else if (/^\d+$/.test(String(value))) ms = Number(value) > 1e11 ? Number(value) : Number(value) * 1000;
  else ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new AgentError(`${label} must be an ISO date/time (e.g. 2024-03-01T09:30Z) or a unix timestamp.`);
  return Math.floor(ms / 1000);
}
function checkInterval(tf, label = 'timeframe') {
  if (!TF_SEC[tf]) throw new AgentError(`${label} must be one of ${INTERVALS.join(', ')}.`);
  return tf;
}
const ctxOf = s => ({ userId: String(s.user), symbol: s.symbol });

// ── Sessions ────────────────────────────────────────────────────────────────
async function loadSession(userId, sessionId, { active = true } = {}) {
  if (!mongoose.isValidObjectId(String(sessionId || ''))) throw new AgentError('Unknown session id. Call list_sessions to see your sessions.', 'NOT_FOUND');
  const s = await AgentReplaySession.findOne({ _id: sessionId, user: userId });
  if (!s) throw new AgentError('Session not found (sessions expire a week after their last use). Call list_sessions or start_session.', 'NOT_FOUND');
  if (active && s.status !== 'active') throw new AgentError('This session has ended. Start a new one with start_session.', 'SESSION_ENDED');
  return s;
}
async function saveSession(s) {
  s.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await s.save();
}

async function stateOf(s, ctx = ctxOf(s)) {
  const v = viewOf(s);
  const [last] = await closedCandles(ctx, s.interval, s.clock, 1);
  const fromSec = s.fromMs / 1000, toSec = s.toMs / 1000;
  const openTrade = s.openTrade ? v.trade(s.openTrade) : null;
  if (openTrade && last) openTrade.unrealizedR = round(rMultipleOf(plain(s.openTrade), last.close));
  return {
    sessionId: String(s._id),
    status: s.status,
    symbol: s.symbol,
    timeframe: s.interval,
    strategy: s.strategy || null,
    blind: v.blind,
    clock: v.iso(s.clock),
    range: { from: v.iso(fromSec), to: v.iso(toSec) },
    progressPct: round(Math.min(100, Math.max(0, ((s.clock - fromSec) / (toSec - fromSec)) * 100)), 1),
    lastCandle: last ? v.candle(last) : null,
    pendingOrder: s.pendingOrder ? v.order(s.pendingOrder) : null,
    openTrade,
    closedTrade: s.closedTrade ? v.trade(s.closedTrade) : null,
    loggedTrades: s.loggedTrades,
  };
}

function randomBlindScale() {
  // Somewhere in 0.5-0.85 or 1.2-2.0: far enough from 1 that real price
  // levels aren't recognisable.
  const r = Math.random();
  return round(r < 0.5 ? 0.5 + r * 0.7 : 1.2 + (r - 0.5) * 1.6, 4);
}

async function startSession(userId, apiKeyId, input) {
  const symbol = String(input.symbol || '').trim().toUpperCase().slice(0, 40);
  if (!symbol) throw new AgentError('symbol is required. Call list_symbols to see what the account offers.');
  const interval = checkInterval(input.interval || '15min', 'interval');
  const context = Math.max(0, Math.min(MAX_CANDLES_PER_CALL, Math.floor(Number(input.context ?? 100)) || 0));
  const strategy = String(input.strategy || '').trim().replace(/^#+/, '').slice(0, 80);
  const nowSec = Math.floor(Date.now() / 1000);

  const active = await AgentReplaySession.countDocuments({ user: userId, status: 'active' });
  if (active >= MAX_ACTIVE_SESSIONS) {
    throw new AgentError(`You already have ${active} active sessions (the limit is ${MAX_ACTIVE_SESSIONS}). End one with end_session first.`, 'TOO_MANY_SESSIONS');
  }

  const strategyVersion = await currentStrategyVersion(userId, strategy);
  const blind = Boolean(input.blind);
  let windows;
  if (blind) {
    // The agent picks how long, the server picks when -- at random inside the
    // pool (default: the last six years), so the agent can't know the date.
    const lengthDays = Math.max(1, Math.min(MAX_BLIND_DAYS, Math.floor(Number(input.lengthDays ?? 30)) || 30));
    const poolFrom = parseTime(input.from, 'from') ?? nowSec - 6 * 365 * DAY;
    const poolTo = Math.min(parseTime(input.to, 'to') ?? nowSec, nowSec);
    const latestStart = poolTo - lengthDays * DAY;
    if (latestStart <= poolFrom) throw new AgentError('The from/to pool is shorter than lengthDays.');
    windows = Array.from({ length: 4 }, () => {
      const start = Math.floor((poolFrom + Math.random() * (latestStart - poolFrom)) / DAY) * DAY;
      return [start, start + lengthDays * DAY];
    });
  } else {
    const from = parseTime(input.from, 'from');
    const to = parseTime(input.to, 'to');
    if (from == null || to == null) throw new AgentError('from and to are required (or pass blind: true to let the server pick a hidden window).');
    if (to <= from) throw new AgentError('to must be after from.');
    if (to > nowSec) throw new AgentError('to must be in the past: a replay only runs over history.');
    if (to - from > MAX_SESSION_DAYS * DAY) throw new AgentError(`A session can span at most ${MAX_SESSION_DAYS} days.`);
    windows = [[from, to]];
  }

  for (const [from, to] of windows) {
    const s = new AgentReplaySession({
      user: userId, apiKey: apiKeyId, symbol, interval, fromMs: from * 1000, toMs: to * 1000, clock: from, strategy, strategyVersion,
      blind: blind ? { enabled: true, timeShift: Math.floor((from - BLIND_EPOCH) / WEEK) * WEEK, priceScale: randomBlindScale() } : { enabled: false },
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    const ctx = ctxOf(s);
    const candles = await closedCandles(ctx, interval, s.clock, Math.max(context, 1));
    // A blind window that landed before the symbol's history: try another.
    if (blind && !candles.length) continue;
    await s.save();
    const v = viewOf(s);
    return {
      ...(await stateOf(s, ctx)),
      candles: candles.slice(-context).map(v.candle),
      note: blind
        ? 'Blind session: dates are shifted (the year is meaningless, weekday and time of day are real) and prices are rescaled. Use the prices you are shown; the server maps them back.'
        : undefined,
    };
  }
  throw new AgentError(`No ${interval} history found for ${symbol} in the windows tried. Narrow the pool with from/to to a period the symbol traded in.`, 'NO_DATA');
}

async function getCandles(userId, sessionId, { timeframe, count = 100, before } = {}) {
  const s = await loadSession(userId, sessionId, { active: false });
  const tf = checkInterval(timeframe || s.interval);
  const v = viewOf(s);
  const n = Math.max(1, Math.min(MAX_CANDLES_PER_CALL, Math.floor(Number(count)) || 100));
  const beforeSec = parseTime(before, 'before');
  const end = beforeSec == null ? s.clock : Math.min(s.clock, v.timeIn(beforeSec));
  const ctx = ctxOf(s);
  const candles = await closedCandles(ctx, tf, end, n);

  // A higher timeframe than the replay's gets its current candle too, built
  // only from what has been revealed so far.
  let forming = null;
  if (end === s.clock && TF_SEC[tf] > TF_SEC[s.interval]) {
    const sec = TF_SEC[tf], baseSec = TF_SEC[s.interval];
    const around = await candlesIn(ctx, tf, s.clock - sec + 1, s.clock);
    const open = around.find(c => c.time < s.clock && c.time + sec > s.clock);
    if (open) {
      const parts = (await candlesIn(ctx, s.interval, open.time, s.clock)).filter(c => c.time + baseSec <= s.clock);
      if (parts.length) {
        forming = {
          time: open.time, open: parts[0].open, close: parts[parts.length - 1].close,
          high: Math.max(...parts.map(c => c.high)), low: Math.min(...parts.map(c => c.low)),
          volume: parts.reduce((sum, c) => sum + (c.volume || 0), 0), forming: true,
        };
      }
    }
  }
  await AgentReplaySession.updateOne({ _id: s._id }, { expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
  return {
    timeframe: tf,
    clock: v.iso(s.clock),
    candles: [...candles, ...(forming ? [forming] : [])].map(v.candle),
  };
}

async function step(userId, sessionId, input = {}) {
  const s = await loadSession(userId, sessionId);
  const v = viewOf(s);
  const ctx = ctxOf(s);
  const sec = TF_SEC[s.interval];
  const endSec = s.toMs / 1000;
  const untilPrice = input.untilPrice == null ? null : v.priceIn(Number(input.untilPrice));
  // Breakout-style stops: the first candle that CLOSES beyond a level (a wick through it doesn't count).
  const closeAbove = input.untilCloseAbove == null ? null : v.priceIn(Number(input.untilCloseAbove));
  const closeBelow = input.untilCloseBelow == null ? null : v.priceIn(Number(input.untilCloseBelow));
  if ([untilPrice, closeAbove, closeBelow].some(x => x != null && !Number.isFinite(x))) throw new AgentError('untilPrice, untilCloseAbove and untilCloseBelow must be numbers.');
  const untilTimeRaw = parseTime(input.untilTime, 'untilTime');
  const untilTime = untilTimeRaw == null ? null : v.timeIn(untilTimeRaw);
  const stopOnTradeExit = input.stopOnTradeExit !== false;
  const maxBars = Math.max(1, Math.min(MAX_STEP_BARS, Math.floor(Number(input.maxBars ?? 2000)) || 2000));
  const hasCondition = untilPrice != null || untilTime != null || closeAbove != null || closeBelow != null;
  const limit = input.bars != null ? Math.max(1, Math.min(maxBars, Math.floor(Number(input.bars)) || 1)) : hasCondition ? maxBars : 1;

  const revealed = [];
  const events = [];
  let stopped = false;
  while (!stopped && revealed.length < limit) {
    const { candles: batch, reachedEnd } = await nextCandles(ctx, s.interval, s.clock, Math.min(limit - revealed.length, 2000), endSec);
    if (!batch.length) {
      if (reachedEnd) events.push({ type: 'session_end', message: 'The replay reached the end of the session range.' });
      else events.push({ type: 'no_data', message: 'No candles for a long stretch after the clock (a gap in the broker history). End the session or start a new one later.' });
      break;
    }
    for (const c of batch) {
      const prevClock = s.clock;
      s.clock = c.time + sec;
      revealed.push(c);
      // A pending order filled in this candle has its stop/target settled on
      // the same 1-minute walk, so the open-trade check below skips it.
      let settledThisCandle = false;
      if (s.pendingOrder) {
        const order = plain(s.pendingOrder);
        const segStart = Math.max(prevClock, c.time);
        const segEnd = order.expiresAt != null ? Math.min(c.time + sec, order.expiresAt) : c.time + sec;
        const res = segEnd > segStart && orderTouched(c, order) ? await resolveOrder(ctx, order, segStart, segEnd) : null;
        if (res && res.filled) {
          s.pendingOrder = null;
          s.openTrade = res.trade;
          settledThisCandle = true;
          events.push({ type: 'order_filled', trade: v.trade(res.trade) });
          if (res.closed) {
            s.closedTrade = closedTradeFrom(res.trade, res.closed.which, res.closed.time, res.closed.price);
            s.openTrade = null;
            events.push({ type: 'trade_closed', trade: v.trade(s.closedTrade), message: 'Call log_trade to record it in the Backtest Log, or discard_trade to drop it.' });
            if (stopOnTradeExit) { stopped = true; break; }
          }
        } else if (order.expiresAt != null && s.clock >= order.expiresAt) {
          s.pendingOrder = null;
          events.push({ type: 'order_expired', order: v.order(order) });
          if (stopOnTradeExit) { stopped = true; break; }
        }
      }
      if (s.openTrade && !settledThisCandle) {
        const trade = plain(s.openTrade);
        const h = levelsHit(c, trade);
        // Only price action after the previous clock counts (the trade was
        // opened at or after it); a candle that opened earlier, or that spans
        // both levels, is settled on smaller candles.
        const which = !h.sl && !h.tp ? null
          : c.time >= prevClock && !(h.sl && h.tp) ? (h.sl ? 'sl' : 'tp')
          : await firstHit(ctx, s.interval, Math.max(prevClock, c.time), c.time + sec, trade);
        if (which) {
          s.closedTrade = closedTradeFrom(trade, which, c.time);
          s.openTrade = null;
          events.push({ type: 'trade_closed', trade: v.trade(s.closedTrade), message: 'Call log_trade to record it in the Backtest Log, or discard_trade to drop it.' });
          if (stopOnTradeExit) { stopped = true; break; }
        }
      }
      if (untilPrice != null && c.low <= untilPrice && untilPrice <= c.high) {
        events.push({ type: 'price_reached', price: v.px(untilPrice), time: v.iso(c.time) });
        stopped = true; break;
      }
      if (closeAbove != null && c.close > closeAbove) {
        events.push({ type: 'close_above', level: v.px(closeAbove), close: v.px(c.close), time: v.iso(c.time) });
        stopped = true; break;
      }
      if (closeBelow != null && c.close < closeBelow) {
        events.push({ type: 'close_below', level: v.px(closeBelow), close: v.px(c.close), time: v.iso(c.time) });
        stopped = true; break;
      }
      if (untilTime != null && s.clock >= untilTime) {
        events.push({ type: 'time_reached', time: v.iso(s.clock) });
        stopped = true; break;
      }
      if (revealed.length >= limit) break;
    }
  }
  // Stopped by a count or condition: say so if that was also the last candle.
  if (!events.some(e => e.type === 'session_end' || e.type === 'no_data')) {
    const peek = await nextCandles(ctx, s.interval, s.clock, 1, endSec);
    if (!peek.candles.length && peek.reachedEnd) events.push({ type: 'session_end', message: 'The replay reached the end of the session range.' });
  }
  await saveSession(s);
  const shown = revealed.slice(-RETURNED_STEP_CANDLES);
  return {
    revealed: revealed.length,
    ...(shown.length < revealed.length ? { note: `Only the last ${shown.length} of ${revealed.length} revealed candles are listed; use get_candles for more.` } : {}),
    candles: shown.map(v.candle),
    events,
    state: await stateOf(s, ctx),
  };
}

async function openTrade(userId, sessionId, input = {}) {
  const s = await loadSession(userId, sessionId);
  const v = viewOf(s);
  if (s.openTrade) throw new AgentError('A trade is already open in this session. Close it (close_trade) or step until it exits.', 'TRADE_OPEN');
  if (s.closedTrade) throw new AgentError('The last trade is closed but not logged yet. Call log_trade to record it or discard_trade to drop it first.', 'UNLOGGED_TRADE');
  if (s.pendingOrder) throw new AgentError('A pending order is waiting. Cancel it (cancel_order) before entering at market.', 'ORDER_PENDING');
  const direction = input.direction;
  if (!['long', 'short'].includes(direction)) throw new AgentError('direction must be long or short.');
  const stopLoss = v.priceIn(Number(input.stopLoss));
  const takeProfit = input.takeProfit == null ? null : v.priceIn(Number(input.takeProfit));
  const riskAmount = input.riskAmount == null ? 100 : Number(input.riskAmount);
  if (!Number.isFinite(stopLoss)) throw new AgentError('stopLoss is required.');
  if (takeProfit != null && !Number.isFinite(takeProfit)) throw new AgentError('takeProfit must be a number.');
  if (!Number.isFinite(riskAmount) || riskAmount <= 0) throw new AgentError('riskAmount must be a positive number of USD.');

  const [last] = await closedCandles(ctxOf(s), s.interval, s.clock, 1);
  if (!last) throw new AgentError('No candle has been revealed yet. Call step first.', 'NO_DATA');
  const entry = last.close;
  const long = direction === 'long';
  if (long ? stopLoss >= entry : stopLoss <= entry) throw new AgentError(`For a ${direction} the stop must be ${long ? 'below' : 'above'} the entry (${v.px(entry)}).`);
  if (takeProfit != null && (long ? takeProfit <= entry : takeProfit >= entry)) throw new AgentError(`For a ${direction} the target must be ${long ? 'above' : 'below'} the entry (${v.px(entry)}).`);

  const features = { ...(await autoFeatures(s, entry, stopLoss)), ...normalizeFeatures(input.features) };
  s.openTrade = { direction, entryTime: last.time, entryPrice: entry, stopLoss, initialStopLoss: stopLoss, takeProfit, riskAmount, features };
  await saveSession(s);
  return { opened: v.trade(s.openTrade), state: await stateOf(s) };
}

async function closeTrade(userId, sessionId) {
  const s = await loadSession(userId, sessionId);
  const v = viewOf(s);
  if (!s.openTrade) throw new AgentError('There is no open trade to close.', 'NO_TRADE');
  const [last] = await closedCandles(ctxOf(s), s.interval, s.clock, 1);
  const trade = plain(s.openTrade);
  const exitPrice = last ? last.close : trade.entryPrice;
  const rMultiple = rMultipleOf(trade, exitPrice);
  s.closedTrade = {
    ...trade, exitTime: last ? last.time : trade.entryTime, exitPrice, exitReason: 'manual',
    outcome: outcomeOf(rMultiple),
    rMultiple, pnlUSD: rMultiple * trade.riskAmount,
  };
  s.openTrade = null;
  await saveSession(s);
  return { closed: v.trade(s.closedTrade), message: 'Call log_trade to record it, or discard_trade to drop it.' };
}

async function discardTrade(userId, sessionId) {
  const s = await loadSession(userId, sessionId);
  if (!s.closedTrade) throw new AgentError('There is no closed, unlogged trade to discard.', 'NO_TRADE');
  s.closedTrade = null;
  await saveSession(s);
  return { discarded: true };
}

async function logTrade(userId, sessionId, input = {}) {
  const s = await loadSession(userId, sessionId);
  if (!s.closedTrade) {
    throw new AgentError(s.openTrade ? 'The trade is still open. Step until it exits or call close_trade first.' : 'There is no closed trade to log.', 'NO_TRADE');
  }
  const t = plain(s.closedTrade);
  const label = new Date(t.entryTime * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const defaultName = `${label} ${s.symbol} ${t.direction === 'long' ? 'Long' : 'Short'}${s.blind?.enabled ? ' (blind)' : ''}`;
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const trade = await BacktestTrade.create({
    user: userId,
    name: String(input.name || defaultName).trim().slice(0, 100),
    ...strategyAndTags(s.strategy, [s.strategy, ...tags]),
    source: 'agent',
    blind: Boolean(s.blind?.enabled),
    symbol: s.symbol,
    interval: s.interval,
    direction: t.direction,
    entryTime: t.entryTime, entryPrice: t.entryPrice,
    exitTime: t.exitTime, exitPrice: t.exitPrice,
    stopLoss: t.initialStopLoss ?? t.stopLoss, takeProfit: t.takeProfit ?? null,
    outcome: t.outcome,
    riskAmount: t.riskAmount,
    pnlUSD: t.pnlUSD,
    rMultiple: t.rMultiple,
    notes: [String(input.notes || ''), stopMovedNote(t)].filter(Boolean).join('\n\n').slice(0, 5000),
    planFollowed: typeof input.planFollowed === 'boolean' ? input.planFollowed : null,
    setupQuality: Math.max(0, Math.min(5, Number(input.setupQuality) || 0)),
    executionQuality: Math.max(0, Math.min(5, Number(input.executionQuality) || 0)),
    mistakes: normalizeTags(input.mistakes),
    lesson: String(input.lesson || '').slice(0, 2000),
    features: { ...(t.features || {}), ...normalizeFeatures(input.features) },
    strategyVersion: s.strategy ? (s.strategyVersion ?? 1) : null,
  });
  s.loggedTrades += 1;
  s.closedTrade = null;
  await saveSession(s);
  return { tradeId: String(trade._id), outcome: t.outcome, rMultiple: round(t.rMultiple), loggedTrades: s.loggedTrades };
}

async function setTimeframe(userId, sessionId, timeframe) {
  const s = await loadSession(userId, sessionId);
  s.interval = checkInterval(timeframe);
  await saveSession(s);
  return stateOf(s);
}

async function getState(userId, sessionId) {
  const s = await loadSession(userId, sessionId, { active: false });
  return stateOf(s);
}

async function listSessions(userId) {
  const sessions = await AgentReplaySession.find({ user: userId }).sort({ updatedAt: -1 }).limit(20);
  return {
    sessions: sessions.map(s => {
      const v = viewOf(s);
      const fromSec = s.fromMs / 1000, toSec = s.toMs / 1000;
      return {
        sessionId: String(s._id), status: s.status, symbol: s.symbol, timeframe: s.interval, strategy: s.strategy || null,
        blind: v.blind, clock: v.iso(s.clock),
        progressPct: round(Math.min(100, Math.max(0, ((s.clock - fromSec) / (toSec - fromSec)) * 100)), 1),
        pendingOrder: Boolean(s.pendingOrder), openTrade: Boolean(s.openTrade), unloggedTrade: Boolean(s.closedTrade), loggedTrades: s.loggedTrades,
      };
    }),
  };
}

async function endSession(userId, sessionId) {
  const s = await loadSession(userId, sessionId);
  const dropped = { pendingOrder: Boolean(s.pendingOrder), openTrade: Boolean(s.openTrade), unloggedTrade: Boolean(s.closedTrade) };
  s.status = 'ended';
  s.pendingOrder = null;
  s.openTrade = null;
  s.closedTrade = null;
  await saveSession(s);
  return { ended: true, loggedTrades: s.loggedTrades, dropped };
}

// ── Entry conditions ("features") ───────────────────────────────────────────
// Recorded on every trade so results can later be split by the conditions a
// trade was taken in (get_metrics groupBy feature:<name>). Two are captured
// automatically; agents add their own (range width, minutes to breakout, ...).
const MAX_FEATURES = 20;
function normalizeFeatures(input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new AgentError('features must be an object of name: value pairs, e.g. { "rangeWidth": 3.2, "session": "NY" }.');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) throw new AgentError(`Feature name "${key}" must be letters, digits or _ (max 40), starting with a letter.`);
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && value.length <= 60) out[key] = value;
    else throw new AgentError(`Feature "${key}" must be a number, true/false, or a short text (max 60 characters).`);
  }
  if (Object.keys(out).length > MAX_FEATURES) throw new AgentError(`At most ${MAX_FEATURES} features per trade.`);
  return out;
}
/** atr14 (session timeframe, real price units) and the stop distance in ATRs, at the clock. */
async function autoFeatures(s, entry, stop) {
  const candles = await closedCandles(ctxOf(s), s.interval, s.clock, 15);
  if (candles.length < 15) return {};
  const tr = candles.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)));
  const atr = tr.reduce((a, b) => a + b, 0) / tr.length;
  return atr > 0 ? { atr14: Number(atr.toPrecision(6)), riskInAtr: round(Math.abs(entry - stop) / atr, 3) } : {};
}
/** The version of a strategy's rules currently in force (1 until an agent revises them). */
async function currentStrategyVersion(userId, name) {
  if (!name) return null;
  const strategy = await BacktestStrategy.findOne({ user: userId, name }).lean();
  if (!strategy) return 1;
  return strategy.versions && strategy.versions.length ? strategy.versions[strategy.versions.length - 1].version : 1;
}

// ── Pending orders, trade management, indicators ────────────────────────────
function orderTouched(c, o) {
  const long = o.direction === 'long';
  return o.type === 'limit' ? (long ? c.low <= o.price : c.high >= o.price) : (long ? c.high >= o.price : c.low <= o.price);
}

/**
 * Walk 1-minute candles in [start, end) for a pending order: find the fill,
 * then the stop/target. A market that gaps through the order price fills at
 * the minute's open. In the fill minute itself only the stop counts, since
 * the order of prices inside one minute is unknown (the conservative reading).
 */
async function resolveOrder(ctx, order, start, end) {
  const long = order.direction === 'long';
  let trade = null;
  for (const m of await candlesIn(ctx, '1min', start, end)) {
    if (!trade) {
      if (!orderTouched(m, order)) continue;
      const gapped = order.type === 'limit' ? (long ? m.open < order.price : m.open > order.price) : (long ? m.open > order.price : m.open < order.price);
      const entryPrice = gapped ? m.open : order.price;
      trade = {
        direction: order.direction, entryTime: m.time, entryPrice, stopLoss: order.stopLoss, initialStopLoss: order.stopLoss,
        takeProfit: order.takeProfit, riskAmount: order.riskAmount, features: order.features,
      };
      // Filled beyond its own stop: out immediately at the fill.
      if (long ? entryPrice <= order.stopLoss : entryPrice >= order.stopLoss) return { filled: true, trade, closed: { which: 'sl', time: m.time, price: entryPrice } };
      if (levelsHit(m, trade).sl) return { filled: true, trade, closed: { which: 'sl', time: m.time } };
      continue;
    }
    const h = levelsHit(m, trade);
    if (h.sl || h.tp) return { filled: true, trade, closed: { which: h.sl ? 'sl' : 'tp', time: m.time } };
  }
  return trade ? { filled: true, trade, closed: null } : null;
}

function stopMovedNote(t) {
  if (t.initialStopLoss == null || t.initialStopLoss === t.stopLoss) return '';
  return `Stop moved from ${t.initialStopLoss} to ${t.stopLoss} during the trade (R is measured from the original stop).`;
}

async function placeOrder(userId, sessionId, input = {}) {
  const s = await loadSession(userId, sessionId);
  const v = viewOf(s);
  if (s.openTrade) throw new AgentError('A trade is already open in this session.', 'TRADE_OPEN');
  if (s.closedTrade) throw new AgentError('The last trade is closed but not logged yet. Call log_trade or discard_trade first.', 'UNLOGGED_TRADE');
  if (s.pendingOrder) throw new AgentError('An order is already pending. Cancel or modify it first.', 'ORDER_PENDING');
  const { type, direction } = input;
  if (!['limit', 'stop'].includes(type)) throw new AgentError('type must be limit or stop.');
  if (!['long', 'short'].includes(direction)) throw new AgentError('direction must be long or short.');
  const price = v.priceIn(Number(input.price));
  const stopLoss = v.priceIn(Number(input.stopLoss));
  const takeProfit = input.takeProfit == null ? null : v.priceIn(Number(input.takeProfit));
  const riskAmount = input.riskAmount == null ? 100 : Number(input.riskAmount);
  if (![price, stopLoss].every(Number.isFinite)) throw new AgentError('price and stopLoss are required numbers.');
  if (takeProfit != null && !Number.isFinite(takeProfit)) throw new AgentError('takeProfit must be a number.');
  if (!Number.isFinite(riskAmount) || riskAmount <= 0) throw new AgentError('riskAmount must be a positive number of USD.');

  const [last] = await closedCandles(ctxOf(s), s.interval, s.clock, 1);
  if (!last) throw new AgentError('No candle has been revealed yet. Call step first.', 'NO_DATA');
  const long = direction === 'long';
  const now = last.close;
  // A limit waits for a better price, a stop for a breakout.
  const belowNow = type === 'limit' ? long : !long;
  if (belowNow ? price >= now : price <= now) {
    throw new AgentError(`A ${direction} ${type} order must be ${belowNow ? 'below' : 'above'} the current price (${v.px(now)}); use open_trade to enter at market.`);
  }
  if (long ? stopLoss >= price : stopLoss <= price) throw new AgentError(`The stop must be ${long ? 'below' : 'above'} the order price.`);
  if (takeProfit != null && (long ? takeProfit <= price : takeProfit >= price)) throw new AgentError(`The target must be ${long ? 'above' : 'below'} the order price.`);

  let expiresAt = null;
  if (input.expiresAfterBars != null) expiresAt = s.clock + Math.max(1, Math.floor(Number(input.expiresAfterBars))) * TF_SEC[s.interval];
  const untilTime = parseTime(input.expiresAt, 'expiresAt');
  if (untilTime != null) expiresAt = v.timeIn(untilTime);
  if (expiresAt != null && expiresAt <= s.clock) throw new AgentError('The expiry must be after the current clock.');

  const features = { ...(await autoFeatures(s, price, stopLoss)), ...normalizeFeatures(input.features) };
  s.pendingOrder = { type, direction, price, stopLoss, takeProfit, riskAmount, placedAt: s.clock, expiresAt, features };
  await saveSession(s);
  return { placed: v.order(s.pendingOrder), message: 'Step forward; an order_filled event reports the fill.' };
}

async function cancelOrder(userId, sessionId) {
  const s = await loadSession(userId, sessionId);
  if (!s.pendingOrder) throw new AgentError('There is no pending order.', 'NO_ORDER');
  s.pendingOrder = null;
  await saveSession(s);
  return { cancelled: true };
}

/** Move the stop/target of the open trade, or the price/stop/target of the pending order. */
async function modifyTrade(userId, sessionId, input = {}) {
  const s = await loadSession(userId, sessionId);
  const v = viewOf(s);
  const num = key => (input[key] == null ? undefined : v.priceIn(Number(input[key])));
  const stopLoss = num('stopLoss');
  const takeProfit = input.removeTakeProfit ? null : num('takeProfit');
  const price = num('price');
  if ([stopLoss, takeProfit, price].some(x => x !== undefined && x !== null && !Number.isFinite(x))) throw new AgentError('Prices must be numbers.');

  if (s.openTrade) {
    if (price !== undefined) throw new AgentError('price only applies to a pending order; the trade is already filled.');
    const [last] = await closedCandles(ctxOf(s), s.interval, s.clock, 1);
    const t = plain(s.openTrade);
    const long = t.direction === 'long';
    const now = last ? last.close : t.entryPrice;
    const next = { stopLoss: stopLoss ?? t.stopLoss, takeProfit: takeProfit === undefined ? t.takeProfit : takeProfit };
    if (long ? next.stopLoss >= now : next.stopLoss <= now) throw new AgentError(`The stop must stay ${long ? 'below' : 'above'} the current price (${v.px(now)}). To exit now, use close_trade.`);
    if (next.takeProfit != null && (long ? next.takeProfit <= now : next.takeProfit >= now)) throw new AgentError(`The target must stay ${long ? 'above' : 'below'} the current price (${v.px(now)}). To exit now, use close_trade.`);
    s.openTrade = { ...t, initialStopLoss: t.initialStopLoss ?? t.stopLoss, ...next };
    await saveSession(s);
    return { modified: v.trade(s.openTrade) };
  }
  if (s.pendingOrder) {
    const o = plain(s.pendingOrder);
    const next = { ...o, price: price ?? o.price, stopLoss: stopLoss ?? o.stopLoss, takeProfit: takeProfit === undefined ? o.takeProfit : takeProfit };
    const long = o.direction === 'long';
    if (long ? next.stopLoss >= next.price : next.stopLoss <= next.price) throw new AgentError(`The stop must be ${long ? 'below' : 'above'} the order price.`);
    if (next.takeProfit != null && (long ? next.takeProfit <= next.price : next.takeProfit >= next.price)) throw new AgentError(`The target must be ${long ? 'above' : 'below'} the order price.`);
    s.pendingOrder = next;
    await saveSession(s);
    return { modified: v.order(s.pendingOrder) };
  }
  throw new AgentError('There is no open trade or pending order to modify.', 'NO_TRADE');
}

const INDICATORS = {
  ema: { params: [20], warmup: p => p * 4 },
  sma: { params: [20], warmup: p => p },
  rsi: { params: [14], warmup: p => p * 5 },
  atr: { params: [14], warmup: p => p * 5 },
  bb: { params: [20, 2], warmup: p => p },
};
function parseIndicator(spec) {
  const [name, ...rest] = String(spec).toLowerCase().trim().split(/[:(),\s]+/).filter(Boolean);
  const def = INDICATORS[name];
  if (!def) throw new AgentError(`Unknown indicator "${spec}". Use ${Object.keys(INDICATORS).map(k => `${k}:${INDICATORS[k].params.join(':')}`).join(', ')}.`);
  const params = def.params.map((d, i) => (rest[i] != null ? Number(rest[i]) : d));
  if (!params.every(p => Number.isFinite(p) && p > 0) || params[0] > 500) throw new AgentError(`Bad parameters in "${spec}".`);
  params[0] = Math.floor(params[0]);
  return { name, params, key: [name, ...params].join('_').replace('.', '_'), warmup: def.warmup(params[0]) };
}
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function smaSeries(values, period) {
  return values.map((_, i) => (i + 1 < period ? null : values.slice(i + 1 - period, i + 1).reduce((a, b) => a + b, 0) / period));
}
function wilder(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let avg = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = avg;
  for (let i = period; i < values.length; i++) { avg = (avg * (period - 1) + values[i]) / period; out[i] = avg; }
  return out;
}
function computeIndicator(ind, candles) {
  const closes = candles.map(c => c.close);
  const [p, mult] = ind.params;
  if (ind.name === 'ema') return { [ind.key]: emaSeries(closes, p) };
  if (ind.name === 'sma') return { [ind.key]: smaSeries(closes, p) };
  if (ind.name === 'rsi') {
    const gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0)); }
    const g = wilder(gains, p), l = wilder(losses, p);
    return { [ind.key]: [null, ...g.map((gv, i) => (gv == null ? null : l[i] === 0 ? 100 : 100 - 100 / (1 + gv / l[i])))] };
  }
  if (ind.name === 'atr') {
    const tr = candles.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
    return { [ind.key]: wilder(tr, p) };
  }
  // Bollinger Bands
  const mid = smaSeries(closes, p);
  const sd = closes.map((_, i) => (mid[i] == null ? null : Math.sqrt(closes.slice(i + 1 - p, i + 1).reduce((a, b) => a + (b - mid[i]) ** 2, 0) / p)));
  return {
    [`${ind.key}_mid`]: mid,
    [`${ind.key}_upper`]: mid.map((m, i) => (m == null ? null : m + mult * sd[i])),
    [`${ind.key}_lower`]: mid.map((m, i) => (m == null ? null : m - mult * sd[i])),
  };
}

/** Indicator values on closed candles only, so they carry no future data. */
async function getIndicators(userId, sessionId, { timeframe, indicators = ['ema:20', 'ema:50', 'rsi:14', 'atr:14'], count = 50 } = {}) {
  const s = await loadSession(userId, sessionId, { active: false });
  const tf = checkInterval(timeframe || s.interval);
  const v = viewOf(s);
  const list = (Array.isArray(indicators) ? indicators : [indicators]).slice(0, 10).map(parseIndicator);
  if (!list.length) throw new AgentError('Ask for at least one indicator.');
  const n = Math.max(1, Math.min(MAX_CANDLES_PER_CALL, Math.floor(Number(count)) || 50));
  const warmup = Math.max(...list.map(i => i.warmup));
  const candles = await closedCandles(ctxOf(s), tf, s.clock, n + warmup);
  const series = Object.assign({}, ...list.map(ind => computeIndicator(ind, candles)));
  const from = Math.max(0, candles.length - n);
  const rows = candles.slice(from).map((c, i) => {
    const row = { time: v.iso(c.time), close: v.px(c.close) };
    // RSI is unitless; every other indicator is a price (rescaled in blind sessions).
    for (const [key, values] of Object.entries(series)) {
      const x = values[from + i];
      row[key] = x == null ? null : key.startsWith('rsi') ? round(x, 2) : v.px(x);
    }
    return row;
  });
  return { timeframe: tf, clock: v.iso(s.clock), values: rows };
}

// ── Strategies and symbols ───────────────────────────────────────────────
async function listStrategies(userId) {
  const [defined, stats] = await Promise.all([
    BacktestStrategy.find({ user: userId }).sort({ name: 1 }).lean(),
    BacktestTrade.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(String(userId)), source: 'agent', strategy: { $ne: '' } } },
      { $group: { _id: '$strategy', trades: { $sum: 1 }, wins: { $sum: { $cond: [{ $eq: ['$outcome', 'win'] }, 1, 0] } }, totalR: { $sum: '$rMultiple' } } },
    ]),
  ]);
  const byName = new Map(stats.map(s => [s._id, s]));
  const names = new Set([...defined.map(s => s.name), ...stats.map(s => s._id)]);
  return {
    strategies: [...names].sort((a, b) => a.localeCompare(b)).map(name => {
      const def = defined.find(s => s.name === name);
      const st = byName.get(name);
      return {
        name,
        description: def?.description || '',
        agentTrades: st?.trades ?? 0,
        agentWinRate: st?.trades ? round((st.wins / st.trades) * 100, 1) : 0,
        agentAvgR: st?.trades ? round(st.totalR / st.trades) : 0,
      };
    }),
  };
}

async function createStrategy(userId, { name, description }) {
  const clean = String(name || '').trim().replace(/^#+/, '').slice(0, 60);
  if (!clean) throw new AgentError('Strategy name is required.');
  const strategy = await BacktestStrategy.findOneAndUpdate(
    { user: userId, name: clean },
    { $setOnInsert: { user: userId, name: clean }, $set: { description: String(description || '').trim().slice(0, 500) } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return { name: strategy.name, description: strategy.description };
}

async function listSymbols(userId, search) {
  const all = await listAccountSymbols({ userId });
  const q = String(search || '').trim().toUpperCase();
  const matches = q ? all.filter(s => s.toUpperCase().includes(q)) : all;
  return { total: matches.length, symbols: matches.slice(0, 300), ...(matches.length > 300 ? { note: 'Only the first 300 are listed; pass search to narrow.' } : {}) };
}

module.exports = {
  AgentError, INTERVALS,
  startSession, getCandles, step, openTrade, closeTrade, discardTrade, logTrade,
  setTimeframe, getState, listSessions, endSession,
  placeOrder, cancelOrder, modifyTrade, getIndicators,
  listStrategies, createStrategy, listSymbols,
  // exported for tests
  normalizeFeatures,
  _internal: { missingRanges, addRange, mergeCandles, firstHit, levelsHit, cache, viewOf, round, plain },
};
