// Runs INSIDE the QuickJS sandbox, before the agent's strategy code (see
// lib/strategyRunner.js). The host pushes one closed candle at a time, so
// nothing here can see the future: every array only ever holds closed bars.
// Orders are not executed here -- actions are collected and handed back to the
// host, which fills and settles them on real 1-minute data.
'use strict';

const __tfs = {};          // tf -> { sec, time[], open[], high[], low[], close[], volume[] }
let __base = null;         // base timeframe name
let __live = false;        // false while warmup bars are pushed (onBar isn't called)
let __tested = -1;         // index of the current bar among tested bars
let __S = { position: null, order: null, events: [], trades: 0, wins: 0, losses: 0, totalR: 0, lastTrade: null, forming: {} };
let __actions = [];
const __logs = [];
let __logCount = 0;

function __defineTf(tf, sec) {
  __tfs[tf] = { sec, time: [], open: [], high: [], low: [], close: [], volume: [] };
}
function __append(tf, b) {
  const s = __tfs[tf];
  s.time.push(b[0]); s.open.push(b[1]); s.high.push(b[2]); s.low.push(b[3]); s.close.push(b[4]); s.volume.push(b[5]);
}

// ── Time zones (no Intl in the sandbox): New York and London DST rules ──────
function __nthSunday(y, m, n) { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + (n - 1) * 7; }
function __lastSunday(y, m) { const last = new Date(Date.UTC(y, m + 1, 0)); return last.getUTCDate() - last.getUTCDay(); }
function __nyOffset(sec) {
  const y = new Date(sec * 1000).getUTCFullYear();
  const start = Date.UTC(y, 2, __nthSunday(y, 2, 2), 7) / 1000;   // 2:00 EST, second Sunday of March
  const end = Date.UTC(y, 10, __nthSunday(y, 10, 1), 6) / 1000;   // 2:00 EDT, first Sunday of November
  return sec >= start && sec < end ? -240 : -300;
}
function __londonOffset(sec) {
  const y = new Date(sec * 1000).getUTCFullYear();
  const start = Date.UTC(y, 2, __lastSunday(y, 2), 1) / 1000;
  const end = Date.UTC(y, 9, __lastSunday(y, 9), 1) / 1000;
  return sec >= start && sec < end ? 60 : 0;
}
const __WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function __clock(sec, offsetMin) {
  const d = new Date((sec + offsetMin * 60) * 1000);
  const hour = d.getUTCHours(), minute = d.getUTCMinutes();
  return { hour, minute, minutes: hour * 60 + minute, weekday: d.getUTCDay(), weekdayName: __WD[d.getUTCDay()], date: d.toISOString().slice(0, 10), offsetMinutes: offsetMin };
}
/** Unix seconds of a wall-clock time in New York / London / UTC on a YYYY-MM-DD date. */
function __zonedTime(zone, date, hour, minute) {
  const [y, m, d] = String(date).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute || 0) / 1000;
  const off = zone === 'ny' ? __nyOffset(guess + 5 * 3600) : zone === 'london' ? __londonOffset(guess) : 0;
  return guess - off * 60;
}

// ── Indicators: pure functions over arrays, plus cached streaming series ────
const ta = {
  sma(values, period) { const out = []; let sum = 0; for (let i = 0; i < values.length; i++) { sum += values[i]; if (i >= period) sum -= values[i - period]; out.push(i >= period - 1 ? sum / period : null); } return out; },
  ema(values, period) { const out = []; const k = 2 / (period + 1); let e = null; for (let i = 0; i < values.length; i++) { if (i < period - 1) { out.push(null); continue; } if (e === null) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j]; e = s / period; } else e = values[i] * k + e * (1 - k); out.push(e); } return out; },
  rma(values, period) { const out = []; let e = null; for (let i = 0; i < values.length; i++) { if (i < period - 1) { out.push(null); continue; } if (e === null) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j]; e = s / period; } else e = (e * (period - 1) + values[i]) / period; out.push(e); } return out; },
  rsi(values, period) { const g = [0], l = [0]; for (let i = 1; i < values.length; i++) { const d = values[i] - values[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); } const ag = ta.rma(g.slice(1), period), al = ta.rma(l.slice(1), period); return [null].concat(ag.map((a, i) => (a == null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + a / al[i])))); },
  trueRange(high, low, close) { return high.map((h, i) => (i === 0 ? h - low[i] : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1])))); },
  atr(high, low, close, period) { return ta.rma(ta.trueRange(high, low, close), period); },
  highest(values, n) { let m = -Infinity; for (let i = Math.max(0, values.length - n); i < values.length; i++) m = Math.max(m, values[i]); return m; },
  lowest(values, n) { let m = Infinity; for (let i = Math.max(0, values.length - n); i < values.length; i++) m = Math.min(m, values[i]); return m; },
  stdev(values, n) { const s = values.slice(-n); const mean = s.reduce((a, b) => a + b, 0) / s.length; return Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length); },
};

// Streaming indicator values per (tf, name, period, source), caught up on demand.
const __series = new Map();
function __indicator(name, period, opts) {
  opts = opts || {};
  const tf = opts.tf || __base;
  const s = __tfs[tf];
  if (!s) throw new Error(`Timeframe ${tf} is not loaded. Add it to timeframes when calling run_strategy.`);
  const source = opts.source || 'close';
  const key = `${tf}|${name}|${period}|${source}`;
  let st = __series.get(key);
  if (!st) { st = { values: [], done: 0, e: null, ag: null, al: null, n: 0, sum: 0 }; __series.set(key, st); }
  const src = source === 'hl2' ? i => (s.high[i] + s.low[i]) / 2 : source === 'hlc3' ? i => (s.high[i] + s.low[i] + s.close[i]) / 3 : i => s[source][i];
  for (let i = st.done; i < s.close.length; i++) {
    let v = null;
    if (name === 'sma') { st.sum += src(i); if (i >= period) st.sum -= src(i - period); v = i >= period - 1 ? st.sum / period : null; }
    else if (name === 'ema' || name === 'rma') {
      if (i === period - 1) { let t = 0; for (let j = 0; j < period; j++) t += src(j); st.e = t / period; }
      else if (i >= period) st.e = name === 'ema' ? src(i) * (2 / (period + 1)) + st.e * (1 - 2 / (period + 1)) : (st.e * (period - 1) + src(i)) / period;
      v = i >= period - 1 ? st.e : null;
    } else if (name === 'atr') {
      const tr = i === 0 ? s.high[i] - s.low[i] : Math.max(s.high[i] - s.low[i], Math.abs(s.high[i] - s.close[i - 1]), Math.abs(s.low[i] - s.close[i - 1]));
      st.n++; if (st.n <= period) { st.sum += tr; if (st.n === period) st.e = st.sum / period; } else st.e = (st.e * (period - 1) + tr) / period;
      v = st.n >= period ? st.e : null;
    } else if (name === 'rsi') {
      if (i > 0) {
        const d = src(i) - src(i - 1), g = Math.max(d, 0), l = Math.max(-d, 0);
        st.n++;
        if (st.n <= period) { st.ag = (st.ag || 0) + g; st.al = (st.al || 0) + l; if (st.n === period) { st.ag /= period; st.al /= period; } }
        else { st.ag = (st.ag * (period - 1) + g) / period; st.al = (st.al * (period - 1) + l) / period; }
        if (st.n >= period) v = st.al === 0 ? 100 : 100 - 100 / (1 + st.ag / st.al);
      }
    } else throw new Error(`Unknown indicator "${name}". Use sma, ema, rma, atr or rsi (or the ta.* functions on ctx.series()).`);
    st.values.push(v);
  }
  st.done = s.close.length;
  const back = opts.back || 0;
  const i = st.values.length - 1 - back;
  return i >= 0 ? st.values[i] : null;
}

// ── The ctx object handed to onBar ──────────────────────────────────────────
function __barAt(tf, i) {
  const s = __tfs[tf];
  if (i < 0 || i >= s.time.length) return null;
  const t = s.time[i];
  return { time: t, iso: new Date(t * 1000).toISOString(), open: s.open[i], high: s.high[i], low: s.low[i], close: s.close[i], volume: s.volume[i] };
}
function __order(kind, direction, price, o) {
  o = o || {};
  __actions.push({ kind, direction, price, stop: o.stop, target: o.target, risk: o.risk, tag: o.tag, features: o.features, expiresInBars: o.expiresInBars, expiresAt: o.expiresAt, notes: o.notes });
}
const __ctx = {
  params: {},
  state: {},
  ta,
  get bar() { return __barAt(__base, __tfs[__base].time.length - 1); },
  get index() { return __tested; },
  get position() { return __S.position; },
  get order() { return __S.order; },
  get events() { return __S.events; },
  get stats() { return { trades: __S.trades, wins: __S.wins, losses: __S.losses, totalR: __S.totalR, lastTrade: __S.lastTrade }; },
  get time() {
    const t = __tfs[__base].time[__tfs[__base].time.length - 1] + __tfs[__base].sec; // the bar's close = now
    return { unix: t, iso: new Date(t * 1000).toISOString(), utc: __clock(t, 0), ny: __clock(t, __nyOffset(t)), london: __clock(t, __londonOffset(t)) };
  },
  /** Last n closed candles (oldest first) of the base or a loaded higher timeframe. */
  bars(n, tf) { tf = tf || __base; const s = __tfs[tf]; if (!s) throw new Error(`Timeframe ${tf} is not loaded.`); const out = []; for (let i = Math.max(0, s.time.length - n); i < s.time.length; i++) out.push(__barAt(tf, i)); return out; },
  /** A closed candle: back = 0 is the latest. */
  candle(back, tf) { tf = tf || __base; const s = __tfs[tf]; if (!s) throw new Error(`Timeframe ${tf} is not loaded.`); return __barAt(tf, s.time.length - 1 - (back || 0)); },
  /** The still-forming candle of a higher timeframe, built only from closed base candles. */
  forming(tf) { return __S.forming[tf] || null; },
  /** Whole closed-candle arrays { time, open, high, low, close, volume } (read-only by convention). */
  series(tf) { tf = tf || __base; const s = __tfs[tf]; if (!s) throw new Error(`Timeframe ${tf} is not loaded.`); return s; },
  indicator: __indicator,
  sma(p, o) { return __indicator('sma', p, o); },
  ema(p, o) { return __indicator('ema', p, o); },
  rsi(p, o) { return __indicator('rsi', p, o); },
  atr(p, o) { return __indicator('atr', p, o); },
  /** Unix seconds of a wall-clock time, e.g. ctx.at('ny', ctx.time.ny.date, 9, 30). */
  at: __zonedTime,
  buy(o) { __order('market', 'long', null, o); },
  sell(o) { __order('market', 'short', null, o); },
  buyLimit(price, o) { __order('limit', 'long', price, o); },
  sellLimit(price, o) { __order('limit', 'short', price, o); },
  buyStop(price, o) { __order('stop', 'long', price, o); },
  sellStop(price, o) { __order('stop', 'short', price, o); },
  cancel() { __actions.push({ kind: 'cancel' }); },
  close(o) { __actions.push({ kind: 'close', notes: o && o.notes }); },
  modify(o) { o = o || {}; __actions.push({ kind: 'modify', stop: o.stop, target: o.target, price: o.price }); },
  log(...args) {
    __logCount++;
    if (__logs.length < 300) __logs.push(`[${new Date((__tfs[__base].time[__tfs[__base].time.length - 1]) * 1000).toISOString().slice(0, 16)}] ` + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 300));
  },
};
const console = { log: (...a) => __ctx.log(...a) };

// ── Host entry points ───────────────────────────────────────────────────────
function __setup(json) {
  const cfg = JSON.parse(json);
  __base = cfg.base;
  for (const [tf, sec] of Object.entries(cfg.timeframes)) __defineTf(tf, sec);
  __ctx.params = cfg.params || {};
  if (typeof onBar !== 'function') throw new Error('Define function onBar(ctx) { ... } in your strategy code.');
}
/** Warmup history: closed candles pushed without calling onBar. */
function __warm(json) {
  const w = JSON.parse(json);
  for (const [tf, rows] of Object.entries(w)) for (const b of rows) __append(tf, b);
}
function __start() {
  __live = true;
  if (typeof init === 'function') init(__ctx);
}
/** One closed base candle (plus any higher-timeframe candles that closed with it); returns the actions as JSON. */
function __step(json) {
  const m = JSON.parse(json);
  __append(__base, m.bar);
  if (m.htf) for (const [tf, rows] of Object.entries(m.htf)) for (const b of rows) __append(tf, b);
  __S = m.state;
  __tested++;
  __actions = [];
  onBar(__ctx);
  return JSON.stringify(__actions);
}
function __finish() {
  if (typeof onEnd === 'function') onEnd(__ctx);
  return JSON.stringify({ logs: __logs, logCount: __logCount });
}
