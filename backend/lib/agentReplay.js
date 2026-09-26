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
const FETCHES_PER_MINUTE = 40;
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

function closedTradeFrom(trade, which, exitTime) {
  const exitPrice = which === 'sl' ? trade.stopLoss : trade.takeProfit;
  const long = trade.direction === 'long';
  const outcome = which === 'tp' ? 'win'
    : (long ? trade.stopLoss >= trade.entryPrice : trade.stopLoss <= trade.entryPrice) ? 'breakeven' : 'loss';
  const rMultiple = rMultipleOf(trade, exitPrice);
  return { ...trade, exitTime, exitPrice, exitReason: which === 'sl' ? 'stop' : 'target', outcome, rMultiple, pnlUSD: rMultiple * trade.riskAmount };
}
function rMultipleOf(trade, price) {
  const risk = trade.direction === 'long' ? trade.entryPrice - trade.stopLoss : trade.stopLoss - trade.entryPrice;
  const gain = trade.direction === 'long' ? price - trade.entryPrice : trade.entryPrice - price;
  return risk !== 0 ? gain / risk : 0;
}

// ── Output (and blind-mode transforms) ──────────────────────────────────────
const round = (v, digits = 3) => (v == null || !Number.isFinite(v) ? v : Number(v.toFixed(digits)));
const plain = doc => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

function viewOf(s) {
  const b = s.blind && s.blind.enabled ? s.blind : null;
  const shift = b ? b.timeShift : 0;
  const scale = b ? b.priceScale : 1;
  const iso = sec => new Date((sec - shift) * 1000).toISOString().replace(/:00\.000Z$/, 'Z').replace(/\.000Z$/, 'Z');
  // cTrader prices have 5 decimals; scaled (blind) ones keep 8 significant digits.
  const px = v => (v == null ? v : b ? Number((v * scale).toPrecision(8)) : Number(v.toFixed(5)));
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
        takeProfit: px(t.takeProfit), riskAmount: t.riskAmount,
        ...(t.exitTime != null ? {
          exitTime: iso(t.exitTime), exitPrice: px(t.exitPrice), exitReason: t.exitReason, outcome: t.outcome,
          rMultiple: round(t.rMultiple), pnlUSD: round(t.pnlUSD, 2),
        } : {}),
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
      user: userId, apiKey: apiKeyId, symbol, interval, fromMs: from * 1000, toMs: to * 1000, clock: from, strategy,
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
  const untilTimeRaw = parseTime(input.untilTime, 'untilTime');
  const untilTime = untilTimeRaw == null ? null : v.timeIn(untilTimeRaw);
  const stopOnTradeExit = input.stopOnTradeExit !== false;
  const maxBars = Math.max(1, Math.min(MAX_STEP_BARS, Math.floor(Number(input.maxBars ?? 2000)) || 2000));
  const hasCondition = untilPrice != null || untilTime != null;
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
      if (s.openTrade) {
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

  s.openTrade = { direction, entryTime: last.time, entryPrice: entry, stopLoss, takeProfit, riskAmount };
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
    outcome: Math.abs(exitPrice - trade.entryPrice) < 1e-9 ? 'breakeven' : rMultiple > 0 ? 'win' : 'loss',
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
    stopLoss: t.stopLoss, takeProfit: t.takeProfit ?? null,
    outcome: t.outcome,
    riskAmount: t.riskAmount,
    pnlUSD: t.pnlUSD,
    rMultiple: t.rMultiple,
    notes: String(input.notes || '').slice(0, 5000),
    planFollowed: typeof input.planFollowed === 'boolean' ? input.planFollowed : null,
    setupQuality: Math.max(0, Math.min(5, Number(input.setupQuality) || 0)),
    executionQuality: Math.max(0, Math.min(5, Number(input.executionQuality) || 0)),
    mistakes: normalizeTags(input.mistakes),
    lesson: String(input.lesson || '').slice(0, 2000),
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
        openTrade: Boolean(s.openTrade), unloggedTrade: Boolean(s.closedTrade), loggedTrades: s.loggedTrades,
      };
    }),
  };
}

async function endSession(userId, sessionId) {
  const s = await loadSession(userId, sessionId);
  const dropped = { openTrade: Boolean(s.openTrade), unloggedTrade: Boolean(s.closedTrade) };
  s.status = 'ended';
  s.openTrade = null;
  s.closedTrade = null;
  await saveSession(s);
  return { ended: true, loggedTrades: s.loggedTrades, dropped };
}

// ── Strategies, symbols, metrics ────────────────────────────────────────────
function statsOf(trades) {
  const n = trades.length;
  const wins = trades.filter(t => t.outcome === 'win').length;
  const losses = trades.filter(t => t.outcome === 'loss').length;
  const rs = trades.map(t => Number(t.rMultiple) || 0);
  const totalR = rs.reduce((a, b) => a + b, 0);
  const grossWin = rs.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = -rs.filter(r => r < 0).reduce((a, b) => a + b, 0);
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const r of rs) { equity += r; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
  return {
    trades: n, wins, losses, breakevens: n - wins - losses,
    winRate: n ? round((wins / n) * 100, 1) : 0,
    avgR: n ? round(totalR / n) : 0,
    expectancyR: n ? round(totalR / n) : 0,
    totalR: round(totalR),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    maxDrawdownR: round(maxDrawdownR),
    totalPnlUSD: round(trades.reduce((sum, t) => sum + (Number(t.pnlUSD) || 0), 0), 2),
  };
}

async function getMetrics(userId, { strategy, source = 'agent' } = {}) {
  const query = { user: userId };
  if (strategy) query.tags = String(strategy).trim().replace(/^#+/, '');
  if (source === 'replay') query.source = { $in: ['replay', null] };
  else if (source === 'agent' || source === 'quick') query.source = source;
  else if (source !== 'all') throw new AgentError('source must be agent, replay, quick or all.');
  const trades = await BacktestTrade.find(query).select('strategy rMultiple outcome pnlUSD entryTime createdAt').lean();
  trades.sort((a, b) => (a.entryTime ? a.entryTime * 1000 : +a.createdAt) - (b.entryTime ? b.entryTime * 1000 : +b.createdAt));
  const byStrategy = new Map();
  for (const t of trades) {
    const key = t.strategy || '(untagged)';
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key).push(t);
  }
  return {
    source,
    overall: statsOf(trades),
    byStrategy: [...byStrategy].map(([name, list]) => ({ strategy: name, ...statsOf(list) })).sort((a, b) => b.trades - a.trades),
  };
}

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
  getMetrics, listStrategies, createStrategy, listSymbols,
  // exported for tests
  _internal: { missingRanges, addRange, mergeCandles, firstHit, levelsHit, cache },
};
