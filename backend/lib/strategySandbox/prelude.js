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
let __S = { positions: [], orders: [], events: [], trades: 0, wins: 0, losses: 0, totalR: 0, lastTrade: null, forming: {} };
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

// Streaming indicator values per (tf, name, settings), caught up on demand:
// each is updated once per new closed candle, so calling it every bar is cheap.
const __series = new Map();
function __tfData(tf) {
  const s = __tfs[tf];
  if (!s) throw new Error(`Timeframe ${tf} is not loaded. Add it to timeframes when calling run_strategy.`);
  return s;
}
function __srcFn(s, source) {
  if (source === 'hl2') return i => (s.high[i] + s.low[i]) / 2;
  if (source === 'hlc3') return i => (s.high[i] + s.low[i] + s.close[i]) / 3;
  if (!s[source]) throw new Error(`Unknown source "${source}": use close, open, high, low, hl2 or hlc3.`);
  return i => s[source][i];
}
const __smoother = (period, kind) => {
  // kind 'ema' | 'rma' | 'sma'; returns update(x) -> value or null while warming up
  let n = 0, sum = 0, e = null; const buf = [];
  return x => {
    n++;
    if (kind === 'sma') { buf.push(x); sum += x; if (buf.length > period) sum -= buf.shift(); return buf.length === period ? sum / period : null; }
    if (n <= period) { sum += x; if (n === period) e = sum / period; return n === period ? e : null; }
    e = kind === 'ema' ? x * (2 / (period + 1)) + e * (1 - 2 / (period + 1)) : (e * (period - 1) + x) / period;
    return e;
  };
};
const __INDICATORS = {
  sma: (s, o) => { const f = __smoother(o.period, 'sma'), src = __srcFn(s, o.source); return i => f(src(i)); },
  ema: (s, o) => { const f = __smoother(o.period, 'ema'), src = __srcFn(s, o.source); return i => f(src(i)); },
  rma: (s, o) => { const f = __smoother(o.period, 'rma'), src = __srcFn(s, o.source); return i => f(src(i)); },
  atr: (s, o) => { const f = __smoother(o.period, 'rma'); return i => f(i === 0 ? s.high[i] - s.low[i] : Math.max(s.high[i] - s.low[i], Math.abs(s.high[i] - s.close[i - 1]), Math.abs(s.low[i] - s.close[i - 1]))); },
  rsi: (s, o) => {
    const g = __smoother(o.period, 'rma'), l = __smoother(o.period, 'rma'), src = __srcFn(s, o.source);
    return i => { if (i === 0) return null; const d = src(i) - src(i - 1); const ag = g(Math.max(d, 0)), al = l(Math.max(-d, 0)); return ag == null ? null : al === 0 ? 100 : 100 - 100 / (1 + ag / al); };
  },
  macd: (s, o) => {
    const fast = __smoother(o.fast || 12, 'ema'), slow = __smoother(o.slow || 26, 'ema'), sig = __smoother(o.signal || 9, 'ema'), src = __srcFn(s, o.source);
    return i => { const a = fast(src(i)), b = slow(src(i)); if (a == null || b == null) return null; const m = a - b, sg = sig(m); return sg == null ? null : { macd: m, signal: sg, hist: m - sg }; };
  },
  adx: (s, o) => {
    const p = o.period, tr = __smoother(p, 'rma'), pdm = __smoother(p, 'rma'), mdm = __smoother(p, 'rma'), adx = __smoother(p, 'rma');
    return i => {
      if (i === 0) return null;
      const up = s.high[i] - s.high[i - 1], dn = s.low[i - 1] - s.low[i];
      const t = tr(Math.max(s.high[i] - s.low[i], Math.abs(s.high[i] - s.close[i - 1]), Math.abs(s.low[i] - s.close[i - 1])));
      const pd = pdm(up > dn && up > 0 ? up : 0), md = mdm(dn > up && dn > 0 ? dn : 0);
      if (t == null || !t) return null;
      const plusDI = 100 * pd / t, minusDI = 100 * md / t, dx = plusDI + minusDI ? 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI) : 0;
      const a = adx(dx);
      return a == null ? null : { adx: a, plusDI, minusDI };
    };
  },
  donchian: (s, o) => i => {
    // Channel of the `period` candles BEFORE this one (so a close above upper is a breakout).
    if (i < o.period) return null;
    let hi = -Infinity, lo = Infinity;
    for (let k = i - o.period; k < i; k++) { hi = Math.max(hi, s.high[k]); lo = Math.min(lo, s.low[k]); }
    return { upper: hi, lower: lo, mid: (hi + lo) / 2 };
  },
  bollinger: (s, o) => {
    const src = __srcFn(s, o.source), mult = o.mult ?? 2;
    return i => {
      if (i < o.period - 1) return null;
      let sum = 0; for (let k = i - o.period + 1; k <= i; k++) sum += src(k);
      const mid = sum / o.period; let v = 0; for (let k = i - o.period + 1; k <= i; k++) v += (src(k) - mid) ** 2;
      const sd = Math.sqrt(v / o.period);
      return { mid, upper: mid + mult * sd, lower: mid - mult * sd, width: 2 * mult * sd };
    };
  },
  keltner: (s, o) => {
    const e = __INDICATORS.ema(s, { period: o.period, source: o.source }), a = __INDICATORS.atr(s, { period: o.atrPeriod || o.period }), mult = o.mult ?? 2;
    return i => { const m = e(i), r = a(i); return m == null || r == null ? null : { mid: m, upper: m + mult * r, lower: m - mult * r }; };
  },
  supertrend: (s, o) => {
    const a = __INDICATORS.atr(s, { period: o.period }), mult = o.mult ?? 3;
    let up = null, dn = null, dir = 1;
    return i => {
      const r = a(i); if (r == null) return null;
      const mid = (s.high[i] + s.low[i]) / 2, c = s.close[i], pc = i > 0 ? s.close[i - 1] : c;
      let bu = mid - mult * r, bd = mid + mult * r;
      if (up != null && pc > up) bu = Math.max(bu, up);
      if (dn != null && pc < dn) bd = Math.min(bd, dn);
      if (dn != null && c > dn) dir = 1; else if (up != null && c < up) dir = -1;
      up = bu; dn = bd;
      return { value: dir === 1 ? up : dn, direction: dir === 1 ? 'up' : 'down' };
    };
  },
};
const __DEFAULT_PERIOD = { sma: 20, ema: 20, rma: 14, atr: 14, rsi: 14, adx: 14, donchian: 20, bollinger: 20, keltner: 20, supertrend: 10, macd: 0 };
function __indicator(name, period, opts) {
  if (period && typeof period === 'object') { opts = period; period = undefined; }
  opts = opts || {};
  if (!__INDICATORS[name]) throw new Error(`Unknown indicator "${name}". Available: ${Object.keys(__INDICATORS).join(', ')} (or ctx.ta.* on ctx.series()).`);
  const tf = opts.tf || __base;
  const s = __tfData(tf);
  const cfg = { period: period ?? opts.period ?? __DEFAULT_PERIOD[name], source: opts.source || 'close', mult: opts.mult, fast: opts.fast, slow: opts.slow, signal: opts.signal, atrPeriod: opts.atrPeriod };
  const key = `${tf}|${name}|${JSON.stringify(cfg)}`;
  let st = __series.get(key);
  if (!st) { st = { values: [], done: 0, update: __INDICATORS[name](s, cfg) }; __series.set(key, st); }
  for (let i = st.done; i < s.close.length; i++) st.values.push(st.update(i));
  st.done = s.close.length;
  const k = st.values.length - 1 - (opts.back || 0);
  return k >= 0 ? st.values[k] : null;
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
  __actions.push({ kind, direction, price, stop: o.stop, target: o.target, risk: o.risk, tag: o.tag, features: o.features, expiresInBars: o.expiresInBars, expiresAt: o.expiresAt, notes: o.notes, id: o.id });
}
const __ctx = {
  params: {},
  state: {},
  ta,
  get bar() { return __barAt(__base, __tfs[__base].time.length - 1); },
  get index() { return __tested; },
  get position() { return __S.positions[0] || null; },
  get positions() { return __S.positions; },
  get order() { return __S.orders[0] || null; },
  get orders() { return __S.orders; },
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
  adx(p, o) { return __indicator('adx', p, o); },
  macd(o) { return __indicator('macd', 0, o); },
  donchian(p, o) { return __indicator('donchian', p, o); },
  bollinger(p, o) { return __indicator('bollinger', p, o); },
  keltner(p, o) { return __indicator('keltner', p, o); },
  supertrend(p, o) { return __indicator('supertrend', p, o); },
  /** Highest high / lowest low of the last n closed candles (including the latest). */
  highest(n, o) { o = o || {}; const s = __tfData(o.tf || __base); return ta.highest(s[o.source || 'high'], n); },
  lowest(n, o) { o = o || {}; const s = __tfData(o.tf || __base); return ta.lowest(s[o.source || 'low'], n); },
  /** Unix seconds of a wall-clock time, e.g. ctx.at('ny', ctx.time.ny.date, 9, 30). */
  at: __zonedTime,
  buy(o) { __order('market', 'long', null, o); },
  sell(o) { __order('market', 'short', null, o); },
  buyLimit(price, o) { __order('limit', 'long', price, o); },
  sellLimit(price, o) { __order('limit', 'short', price, o); },
  buyStop(price, o) { __order('stop', 'long', price, o); },
  sellStop(price, o) { __order('stop', 'short', price, o); },
  cancel(o) { __actions.push({ kind: 'cancel', id: o && o.id }); },
  close(o) { o = o || {}; __actions.push({ kind: 'close', id: o.id, fraction: o.fraction, notes: o.notes }); },
  modify(o) { o = o || {}; __actions.push({ kind: 'modify', id: o.id, stop: o.stop, target: o.target, price: o.price }); },
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
  __ctx.symbol = cfg.symbol || null;
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
