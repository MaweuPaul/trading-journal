// run_strategy: backtest strategy code an agent writes, on the server, over
// cTrader history -- so new strategies need no new server code.
//
// The code runs in a QuickJS WebAssembly sandbox (no network, files, process
// or host objects; memory and CPU capped). The host pushes one closed candle
// at a time into it (prelude.js), so the code never holds future data. The
// code only DECIDES: every fill, stop and target is settled here, by the same
// rules as the replay engine (lib/agentReplay.js), drilling down to 1-minute
// candles when one candle can't tell what happened first.
const fs = require('fs');
const path = require('path');
const { getQuickJS } = require('quickjs-emscripten');
const StrategyRun = require('../models/StrategyRun');
const BacktestTrade = require('../models/BacktestTrade');
const BacktestStrategy = require('../models/BacktestStrategy');
const replay = require('./agentReplay');
const backtestLog = require('./agentBacktestLog');
const { strategyAndTags } = require('./backtestTags');
const { confidenceFor } = require('./confidence');

const { AgentError, TF_SEC } = replay;
const PRELUDE = fs.readFileSync(path.join(__dirname, 'strategySandbox', 'prelude.js'), 'utf8');

const MAX_CODE_CHARS = 100_000;
const MAX_BASE_BARS = 250_000;      // per symbol
const MAX_TOTAL_BARS = 400_000;     // all symbols of a run
const MAX_SYMBOLS = 20;
const MAX_POSITIONS = 20;           // positions + pending orders open at once (maxPositions)
const MAX_SPAN_DAYS = 25 * 365;
const MAX_WARMUP_BARS = 2000;
const MAX_TRADES = 5000;
const MAX_LOGGED_TRADES = 3000;
const VM_MEMORY_BYTES = 128 * 1024 * 1024;
const VM_CALL_MS = 2000;           // one onBar call
const VM_TOTAL_MS = 180_000;       // all strategy code in one run
const MAX_RUNS_PER_USER = 2;
const MAX_RUNS_GLOBAL = Math.max(1, Number(process.env.STRATEGY_RUNS_MAX) || 2);
const DAY = 86400;
const PREFETCH_1M_SEC = 14 * DAY;

const round = (v, d = 5) => (v == null || !Number.isFinite(v) ? v ?? null : Number(v.toFixed(d)) || 0);
const iso = s => (Number.isFinite(s) ? new Date(s * 1000).toISOString().replace(':00.000Z', 'Z') : null);
const active = new Map(); // runId -> { userId, cancelled }

function parseTime(value, label) {
  if (value == null || value === '') throw new AgentError(`${label} is required.`);
  const ms = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
  if (!Number.isFinite(ms)) throw new AgentError(`${label} is not a valid date.`);
  return Math.floor(ms / 1000);
}

function validate(input) {
  const code = String(input.code || '');
  if (!code.trim()) throw new AgentError('code is required: JavaScript defining function onBar(ctx) { ... }. Call strategy_api for the reference.');
  if (code.length > MAX_CODE_CHARS) throw new AgentError(`code is limited to ${MAX_CODE_CHARS} characters.`);
  const symbols = [...new Set([...(input.symbols || []), ...(input.symbol ? [input.symbol] : [])].map(x => String(x).trim().toUpperCase()).filter(Boolean))];
  if (!symbols.length) throw new AgentError('symbol (or symbols) is required.');
  if (symbols.length > MAX_SYMBOLS) throw new AgentError(`At most ${MAX_SYMBOLS} symbols per run.`);
  const timeframe = input.timeframe || '15min';
  if (!TF_SEC[timeframe]) throw new AgentError(`timeframe must be one of ${Object.keys(TF_SEC).join(', ')}.`);
  const sec = TF_SEC[timeframe];
  const from = parseTime(input.from, 'from');
  const to = Math.min(parseTime(input.to, 'to'), Math.floor(Date.now() / 1000));
  if (to <= from) throw new AgentError('to must be after from, and from in the past.');
  if (to - from > MAX_SPAN_DAYS * DAY) throw new AgentError(`A run covers at most ${MAX_SPAN_DAYS / 365} years.`);
  const barsPerSymbol = (to - from) / sec * (5 / 7);
  if (barsPerSymbol > MAX_BASE_BARS) throw new AgentError(`That is more than ${MAX_BASE_BARS} ${timeframe} candles; use a higher timeframe or a shorter range.`);
  if (barsPerSymbol * symbols.length > MAX_TOTAL_BARS) throw new AgentError(`${symbols.length} symbols x ~${Math.round(barsPerSymbol)} candles is more than ${MAX_TOTAL_BARS} in one run; use fewer symbols, a higher timeframe or a shorter range.`);
  const timeframes = [...new Set(input.timeframes || [])];
  for (const tf of timeframes) {
    if (!TF_SEC[tf]) throw new AgentError(`timeframes: ${tf} is not a timeframe.`);
    if (TF_SEC[tf] <= sec) throw new AgentError(`timeframes must be higher than the base timeframe (${timeframe}); ${tf} is not.`);
  }
  if (timeframes.length > 4) throw new AgentError('At most 4 extra timeframes.');
  const params = input.params ?? {};
  if (typeof params !== 'object' || Array.isArray(params) || JSON.stringify(params).length > 20_000) throw new AgentError('params must be an object (under 20 KB of JSON).');
  const num = (v, d, min, max) => (v == null ? d : Math.max(min, Math.min(max, Number(v))));
  const settings = {
    symbol: symbols[0], symbols, timeframe, from, to, timeframes, params,
    warmupBars: Math.floor(num(input.warmupBars, 300, 0, MAX_WARMUP_BARS)),
    riskAmount: num(input.riskAmount, 100, 0.01, 1e9),
    maxPositions: Math.floor(num(input.maxPositions, 1, 1, MAX_POSITIONS)),
    spread: num(input.costs?.spread, 0, 0, 1e9),
    commission: num(input.costs?.commission, 0, 0, 1e9),
    logAs: input.logAs ? String(input.logAs).trim().slice(0, 60) : null,
  };
  if ([settings.riskAmount, settings.spread, settings.commission, settings.maxPositions].some(v => !Number.isFinite(v))) throw new AgentError('riskAmount, maxPositions and costs must be numbers.');
  return { code, name: String(input.name || '').slice(0, 100), settings };
}

// ── The sandbox ─────────────────────────────────────────────────────────────
let quickjs = null;
async function newSandbox(code, budget = { used: 0 }) {
  quickjs = quickjs || await getQuickJS();
  const rt = quickjs.newRuntime();
  rt.setMemoryLimit(VM_MEMORY_BYTES);
  rt.setMaxStackSize(1024 * 1024);
  let deadline = Infinity;
  rt.setInterruptHandler(() => Date.now() > deadline);
  const vm = rt.newContext();
  const run = (src, file) => {
    const r = vm.evalCode(src, file);
    if (r.error) { const e = vm.dump(r.error); r.error.dispose(); throw sandboxError(e); }
    r.value.dispose();
  };
  run(PRELUDE, 'prelude.js');
  run(code, 'strategy.js');
  const fns = {};
  const call = (name, arg) => {
    const fn = fns[name] || (fns[name] = vm.getProp(vm.global, name));
    const argH = arg == null ? null : vm.newString(arg);
    const started = Date.now();
    deadline = started + Math.min(VM_CALL_MS, Math.max(1, VM_TOTAL_MS - budget.used));
    const r = argH ? vm.callFunction(fn, vm.undefined, argH) : vm.callFunction(fn, vm.undefined);
    budget.used += Date.now() - started;
    deadline = Infinity;
    if (argH) argH.dispose();
    if (r.error) {
      const e = vm.dump(r.error); r.error.dispose();
      const err = sandboxError(e);
      if (/interrupted/i.test(err.message)) err.message = budget.used >= VM_TOTAL_MS ? `Strategy code used more than ${VM_TOTAL_MS / 1000} s of CPU in total.` : `One onBar call ran longer than ${VM_CALL_MS / 1000} s (an endless loop?).`;
      throw err;
    }
    const out = vm.typeof(r.value) === 'string' ? vm.getString(r.value) : null;
    r.value.dispose();
    return out;
  };
  const dispose = () => { for (const h of Object.values(fns)) h.dispose(); vm.dispose(); rt.dispose(); };
  return { call, dispose };
}
function sandboxError(e) {
  const message = e && typeof e === 'object' ? `${e.name || 'Error'}: ${e.message}` : String(e);
  const where = e && e.stack ? String(e.stack).split('\n').filter(l => /strategy\.js/.test(l)).slice(0, 3).map(l => l.trim()).join(' | ') : '';
  const err = new AgentError(`${message}${where ? ` (${where})` : ''}`, 'STRATEGY_ERROR');
  return err;
}

// ── Execution (host side) ───────────────────────────────────────────────────
const barRow = c => [c.time, c.open, c.high, c.low, c.close, c.volume ?? 0];

function atrAt(bars, i, period = 14) {
  if (i < period) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const c = bars[k], p = bars[k - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / period;
}

/** Every symbol in turn, each with a fresh sandbox; one CPU budget for the whole run. */
async function execute(runId, userId, code, s, opts = {}) {
  const budget = { used: 0 };
  const out = { trades: [], rejected: { count: 0, first: [] }, logs: [], logCount: 0, approxFills: 0, bars: 0, cancelled: false, perSymbol: {} };
  const t0 = Date.now();
  for (const [k, symbol] of s.symbols.entries()) {
    const r = await executeSymbol(runId, userId, code, { ...s, symbol }, budget, patch => opts.onProgress && opts.onProgress({ ...patch, symbol, symbolIndex: k + 1, symbols: s.symbols.length }));
    out.trades.push(...r.trades);
    out.rejected.count += r.rejected.count;
    out.rejected.first.push(...r.rejected.first.slice(0, 20 - out.rejected.first.length));
    const prefix = s.symbols.length > 1 ? `${symbol} ` : '';
    out.logs.push(...r.logs.slice(0, Math.max(0, 300 - out.logs.length)).map(l => prefix + l));
    out.logCount += r.logCount;
    out.approxFills += r.approxFills;
    out.bars += r.bars;
    out.perSymbol[symbol] = { bars: r.bars, trades: r.trades.length };
    if (r.cancelled) { out.cancelled = true; break; }
  }
  out.trades.sort((a, b) => a.entryTime - b.entryTime);
  out.seconds = Math.round((Date.now() - t0) / 1000);
  return out;
}

async function executeSymbol(runId, userId, code, s, budget, progress) {
  const ctx = { userId: String(userId), symbol: s.symbol };
  const sec = TF_SEC[s.timeframe];
  await progress({ phase: 'loading candles' });

  const warm = s.warmupBars ? await replay.closedCandles(ctx, s.timeframe, s.from, s.warmupBars) : [];
  const bars = (await replay.candlesIn(ctx, s.timeframe, s.from, s.to)).filter(c => c.time + sec <= s.to);
  if (!bars.length) throw new AgentError(`No ${s.timeframe} candles for ${s.symbol} between those dates.`, 'NO_DATA');
  const htf = {};
  for (const tf of s.timeframes) {
    const hs = TF_SEC[tf];
    const warmH = s.warmupBars ? await replay.closedCandles(ctx, tf, s.from, Math.min(s.warmupBars, 500)) : [];
    const main = await replay.candlesIn(ctx, tf, s.from - hs, s.to);
    htf[tf] = { sec: hs, bars: [...warmH, ...main.filter(c => !warmH.length || c.time > warmH[warmH.length - 1].time)], next: 0 };
  }

  const sb = await newSandbox(code, budget);
  try {
    sb.call('__setup', JSON.stringify({ base: s.timeframe, timeframes: { [s.timeframe]: sec, ...Object.fromEntries(s.timeframes.map(tf => [tf, TF_SEC[tf]])) }, params: { ...s.params }, symbol: s.symbol }));
    // Warmup: history before `from`, including higher-timeframe candles closed by then.
    const warmup = { [s.timeframe]: warm.map(barRow) };
    for (const [tf, h] of Object.entries(htf)) {
      const rows = [];
      while (h.next < h.bars.length && h.bars[h.next].time + h.sec <= s.from) rows.push(barRow(h.bars[h.next++]));
      warmup[tf] = rows;
    }
    sb.call('__warm', JSON.stringify(warmup));
    sb.call('__start');

    const all = [...warm, ...bars]; // for ATR features
    const offset = warm.length;
    const trades = [];
    const rejected = { count: 0, first: [] };
    let pendingEvents = [];
    const reject = (bar, reason) => { rejected.count++; if (rejected.first.length < 20) rejected.first.push(`${s.symbols.length > 1 ? `${s.symbol} ` : ''}${iso(bar.time)}: ${reason}`); pendingEvents.push({ type: 'rejected', reason }); };
    let positions = [], orders = [], seq = 0, approxFills = 0;
    let wins = 0, losses = 0, totalR = 0;
    const fetched1m = [];
    const ensure1m = async (t) => {
      if (sec <= 60 || fetched1m.some(([a, b]) => t >= a && t < b)) return;
      const end = Math.min(t + PREFETCH_1M_SEC, s.to + DAY);
      await replay.candlesIn(ctx, '1min', t, end);
      fetched1m.push([t, end]);
    };
    // R of a position: partial exits already taken plus the rest at `price`.
    const rNow = (p, price) => p.realizedR + p.size * replay.rMultipleOf(p, price);
    const finish = (p, exitTime, exitPrice, reason) => {
      positions = positions.filter(x => x !== p);
      let r = rNow(p, exitPrice);
      if (s.commission) r -= s.commission / p.riskAmount;
      const outcome = reason === 'target' && !p.partials.length ? 'win' : replay.outcomeOf(r);
      trades.push({
        symbol: s.symbol, id: p.id, direction: p.direction, entryTime: p.entryTime, entryPrice: p.entryPrice, exitTime, exitPrice, exitReason: reason,
        stopLoss: p.initialStopLoss, finalStopLoss: p.stopLoss, takeProfit: p.takeProfit, riskAmount: p.riskAmount,
        rMultiple: r, pnlUSD: r * p.riskAmount, outcome, barsHeld: p.barsHeld, tag: p.tag || null, notes: p.notes || '', features: p.features || {},
        ...(p.partials.length ? { partials: p.partials } : {}), ...(p.approx ? { approxFill: true } : {}),
      });
      if (outcome === 'win') wins++; else if (outcome === 'loss') losses++;
      totalR += r;
      pendingEvents.push({ type: 'closed', id: p.id, reason, rMultiple: round(r, 3), outcome });
      if (trades.length >= MAX_TRADES) throw new AgentError(`The strategy made more than ${MAX_TRADES} trades on ${s.symbol}; stopping.`, 'TOO_MANY_TRADES');
    };
    const entryCost = (direction, price) => (direction === 'long' ? price + s.spread : price - s.spread);
    const open = (fields, i) => {
      const p = { size: 1, realizedR: 0, partials: [], barsHeld: 0, ...fields };
      p.features = { ...features(all, offset + i, p.entryPrice, p.stopLoss), ...(fields.features || {}) };
      positions.push(p);
      return p;
    };

    const t0 = Date.now();
    let lastReport = 0;
    for (let i = 0; i < bars.length; i++) {
      if (active.get(runId)?.cancelled) return { trades, rejected, logs: [], logCount: 0, approxFills, bars: i, cancelled: true };
      const c = bars[i];
      const T = c.time, TE = T + sec;
      const events = pendingEvents; pendingEvents = [];

      // 1. What happened to open positions and pending orders during this candle.
      for (const p of [...positions]) {
        p.barsHeld++;
        const h = replay.levelsHit(c, p);
        if (!h.sl && !h.tp) continue;
        let which = !(h.sl && h.tp) ? (h.sl ? 'sl' : 'tp') : null;
        if (!which) { await ensure1m(T); which = await replay.firstHit(ctx, s.timeframe, T, TE, p) || 'sl'; }
        finish(p, T, which === 'sl' ? p.stopLoss : p.takeProfit, which === 'sl' ? 'stop' : 'target');
      }
      for (const o of [...orders]) {
        const segStart = Math.max(o.placedAt, T);
        const segEnd = o.expiresAt != null ? Math.min(TE, o.expiresAt) : TE;
        if (segEnd > segStart && replay.orderTouched(c, o)) {
          await ensure1m(T);
          let res = await replay.resolveOrder(ctx, o, segStart, segEnd);
          if (!res) {
            // No 1-minute data here (old history): fill at the order price (or the open if it gapped) and
            // settle the rest of this candle conservatively -- a stop inside the candle counts as hit.
            const long = o.direction === 'long';
            const gapped = o.type === 'limit' ? (long ? c.open < o.price : c.open > o.price) : (long ? c.open > o.price : c.open < o.price);
            const trade = { direction: o.direction, entryTime: T, entryPrice: gapped ? c.open : o.price, stopLoss: o.stopLoss, initialStopLoss: o.stopLoss, takeProfit: o.takeProfit, riskAmount: o.riskAmount };
            res = { filled: true, trade, approx: true, closed: replay.levelsHit(c, trade).sl ? { which: 'sl', time: T } : null };
          }
          if (res && res.filled) {
            orders = orders.filter(x => x !== o);
            if (res.approx) approxFills++;
            const p = open({ ...res.trade, id: o.id, entryPrice: entryCost(o.direction, res.trade.entryPrice), tag: o.tag, notes: o.notes, features: o.features, approx: Boolean(res.approx) }, i);
            events.push({ type: 'filled', id: p.id, price: round(p.entryPrice), time: iso(res.trade.entryTime) });
            if (res.closed) finish(p, res.closed.time, res.closed.price ?? (res.closed.which === 'sl' ? p.stopLoss : p.takeProfit), res.closed.which === 'sl' ? 'stop' : 'target');
            else if (segEnd < TE) {
              await ensure1m(segEnd);
              const which = await replay.firstHit(ctx, s.timeframe, segEnd, TE, p);
              if (which) finish(p, T, which === 'sl' ? p.stopLoss : p.takeProfit, which === 'sl' ? 'stop' : 'target');
            }
            continue;
          }
        }
        if (o.expiresAt != null && TE >= o.expiresAt) { orders = orders.filter(x => x !== o); events.push({ type: 'expired', id: o.id }); }
      }

      // 2. Higher-timeframe candles that closed with this one, and the forming ones.
      const htfRows = {};
      const forming = {};
      for (const [tf, h] of Object.entries(htf)) {
        const rows = [];
        while (h.next < h.bars.length && h.bars[h.next].time + h.sec <= TE) rows.push(barRow(h.bars[h.next++]));
        if (rows.length) htfRows[tf] = rows;
        const cur = h.bars[h.next];
        if (cur && cur.time <= T) {
          // Built from base candles of this higher candle that have closed by now.
          let f = null;
          for (let k = i; k >= 0 && bars[k].time >= cur.time; k--) {
            const b = bars[k];
            f = f ? { ...f, open: b.open, high: Math.max(f.high, b.high), low: Math.min(f.low, b.low), volume: f.volume + (b.volume || 0) } : { time: cur.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
          }
          if (f) forming[tf] = { ...f, iso: iso(f.time) };
        }
      }

      // 3. The strategy decides.
      const snapshot = {
        positions: positions.map(p => ({
          id: p.id, direction: p.direction, entryPrice: round(p.entryPrice), entryTime: p.entryTime, stopLoss: round(p.stopLoss), initialStopLoss: round(p.initialStopLoss),
          takeProfit: round(p.takeProfit), riskAmount: p.riskAmount, size: round(p.size, 4), barsHeld: p.barsHeld, tag: p.tag || null,
          unrealizedR: round(rNow(p, c.close), 3),
        })),
        orders: orders.map(o => ({ id: o.id, type: o.type, direction: o.direction, price: round(o.price), stopLoss: round(o.stopLoss), takeProfit: round(o.takeProfit), expiresAt: o.expiresAt, tag: o.tag || null })),
        events, trades: trades.length, wins, losses, totalR: round(totalR, 3),
        lastTrade: trades.length ? (({ id, direction, rMultiple, outcome, exitReason, exitTime, tag }) => ({ id, direction, rMultiple: round(rMultiple, 3), outcome, exitReason, exitTime, tag }))(trades[trades.length - 1]) : null,
        forming,
      };
      const actions = JSON.parse(sb.call('__step', JSON.stringify({ bar: barRow(c), htf: htfRows, state: snapshot })) || '[]');

      // 4. Apply its actions in order, at this candle's close.
      const now = c.close;
      const pick = (list, id) => (id == null ? list : list.filter(x => x.id === String(id)));
      for (const a of actions) {
        if (a.kind === 'close') {
          const targets = pick(positions, a.id);
          if (!targets.length) { reject(c, `close: ${a.id == null ? 'no open position' : `no position ${a.id}`}`); continue; }
          const fraction = a.fraction == null ? 1 : Number(a.fraction);
          if (!(fraction > 0 && fraction <= 1)) { reject(c, 'close: fraction must be between 0 and 1'); continue; }
          for (const p of targets) {
            if (a.notes) p.notes = [p.notes, String(a.notes)].filter(Boolean).join(' ');
            if (fraction >= 1) { finish(p, T, now, 'manual'); continue; }
            const part = p.size * fraction;
            p.realizedR += part * replay.rMultipleOf(p, now);
            p.size -= part;
            p.partials.push({ time: iso(T), price: round(now), portion: round(part, 4) });
            events.push({ type: 'partial', id: p.id, portion: round(part, 4) });
          }
        } else if (a.kind === 'cancel') {
          orders = a.id == null ? [] : orders.filter(o => o.id !== String(a.id));
        } else if (a.kind === 'modify') {
          const stop = a.stop == null ? undefined : Number(a.stop), target = a.target == null ? undefined : Number(a.target), price = a.price == null ? undefined : Number(a.price);
          const ps = pick(positions, a.id), os = pick(orders, a.id);
          if (ps.length) {
            for (const p of ps) {
              const long = p.direction === 'long';
              const next = { stopLoss: stop ?? p.stopLoss, takeProfit: target === undefined ? p.takeProfit : target };
              if (!Number.isFinite(next.stopLoss) || (long ? next.stopLoss >= now : next.stopLoss <= now)) { reject(c, `modify ${p.id}: the stop must stay ${long ? 'below' : 'above'} the price (${now}); use ctx.close() to exit`); continue; }
              if (next.takeProfit != null && (long ? next.takeProfit <= now : next.takeProfit >= now)) { reject(c, `modify ${p.id}: the target must stay ${long ? 'above' : 'below'} the price (${now})`); continue; }
              Object.assign(p, next);
            }
          } else if (os.length) {
            for (const o of os) {
              const long = o.direction === 'long';
              const next = { price: price ?? o.price, stopLoss: stop ?? o.stopLoss, takeProfit: target === undefined ? o.takeProfit : target };
              if (long ? next.stopLoss >= next.price : next.stopLoss <= next.price) { reject(c, `modify ${o.id}: the stop must be beyond the order price`); continue; }
              Object.assign(o, next);
            }
          } else reject(c, `modify: ${a.id == null ? 'no position or order' : `no position or order ${a.id}`}`);
        } else if (['market', 'limit', 'stop'].includes(a.kind)) {
          const label = `${a.kind} ${a.direction}`;
          if (positions.length + orders.length >= s.maxPositions) { reject(c, `${label}: ${s.maxPositions} position(s)/order(s) already open (maxPositions); close or cancel one first`); continue; }
          const id = a.id != null ? String(a.id).slice(0, 40) : `t${++seq}`;
          if (positions.some(p => p.id === id) || orders.some(o => o.id === id)) { reject(c, `${label}: id ${id} is already in use`); continue; }
          const long = a.direction === 'long';
          const stopLoss = Number(a.stop), takeProfit = a.target == null ? null : Number(a.target);
          const riskAmount = a.risk == null ? s.riskAmount : Number(a.risk);
          let feats = {};
          try { feats = replay.normalizeFeatures(a.features); } catch (err) { reject(c, err.message); continue; }
          if (!Number.isFinite(stopLoss)) { reject(c, `${label}: stop is required`); continue; }
          if (takeProfit != null && !Number.isFinite(takeProfit)) { reject(c, `${label}: target must be a number`); continue; }
          if (!(riskAmount > 0)) { reject(c, `${label}: risk must be a positive USD amount`); continue; }
          const tag = a.tag == null ? null : String(a.tag).slice(0, 60);
          const notes = a.notes == null ? '' : String(a.notes).slice(0, 1000);
          if (a.kind === 'market') {
            const entry = entryCost(a.direction, now);
            if (long ? stopLoss >= entry : stopLoss <= entry) { reject(c, `${label}: the stop (${stopLoss}) must be ${long ? 'below' : 'above'} the entry (${round(entry)})`); continue; }
            if (takeProfit != null && (long ? takeProfit <= entry : takeProfit >= entry)) { reject(c, `${label}: the target must be ${long ? 'above' : 'below'} the entry (${round(entry)})`); continue; }
            open({ id, direction: a.direction, entryTime: T, entryPrice: entry, stopLoss, initialStopLoss: stopLoss, takeProfit, riskAmount, tag, notes, features: feats }, i);
            pendingEvents.push({ type: 'opened', id });
          } else {
            const price = Number(a.price);
            const belowNow = a.kind === 'limit' ? long : !long;
            if (!Number.isFinite(price) || (belowNow ? price >= now : price <= now)) { reject(c, `${label}: the price must be ${belowNow ? 'below' : 'above'} the current price (${now})`); continue; }
            if (long ? stopLoss >= price : stopLoss <= price) { reject(c, `${label}: the stop must be ${long ? 'below' : 'above'} the order price`); continue; }
            if (takeProfit != null && (long ? takeProfit <= price : takeProfit >= price)) { reject(c, `${label}: the target must be ${long ? 'above' : 'below'} the order price`); continue; }
            let expiresAt = null;
            if (a.expiresInBars != null) expiresAt = TE + Math.max(1, Math.floor(Number(a.expiresInBars))) * sec;
            if (a.expiresAt != null) expiresAt = Number(a.expiresAt);
            if (expiresAt != null && !(expiresAt > TE)) { reject(c, `${label}: the expiry must be after now`); continue; }
            orders.push({ id, type: a.kind, direction: a.direction, price, stopLoss, takeProfit, riskAmount, placedAt: TE, expiresAt, tag, notes, features: feats });
          }
        }
      }

      if (Date.now() - lastReport > 3000) {
        lastReport = Date.now();
        await progress({ phase: 'running', bar: i + 1, of: bars.length, at: iso(TE), trades: trades.length, seconds: Math.round((Date.now() - t0) / 1000) });
      }
    }
    const last = bars[bars.length - 1];
    for (const p of [...positions]) finish(p, last.time, last.close, 'end');
    const fin = JSON.parse(sb.call('__finish') || '{}');
    return { trades, rejected, logs: fin.logs || [], logCount: fin.logCount || 0, approxFills, bars: bars.length, cancelled: false };
  } finally {
    sb.dispose();
  }
}

/** atr14 on the base timeframe at entry and the stop distance in ATRs (same as the replay records). */
function features(all, i, entry, stop) {
  const atr = atrAt(all, i);
  return atr > 0 ? { atr14: Number(atr.toPrecision(6)), riskInAtr: round(Math.abs(entry - stop) / atr, 3) } : {};
}

// ── Runs: start, follow, cancel ─────────────────────────────────────────────
async function startRun(userId, apiKeyId, input = {}, { wait = 20 } = {}) {
  const { code, name, settings } = validate(input);
  const mine = [...active.values()].filter(r => r.userId === String(userId)).length;
  if (mine >= MAX_RUNS_PER_USER) throw new AgentError(`At most ${MAX_RUNS_PER_USER} strategy runs at a time. Wait for one to finish (get_strategy_run) or cancel it.`, 'BUSY');
  if (active.size >= MAX_RUNS_GLOBAL) throw new AgentError('The server is busy with other strategy runs. Try again in a minute.', 'BUSY');
  // Syntax and onBar check before anything is stored or fetched.
  const probe = await newSandbox(code);
  try { probe.call('__setup', JSON.stringify({ base: settings.timeframe, timeframes: { [settings.timeframe]: TF_SEC[settings.timeframe] }, params: settings.params })); } finally { probe.dispose(); }

  let holdoutFrom = null, strategyVersion = null;
  if (settings.logAs) {
    const strat = await BacktestStrategy.findOne({ user: userId, name: settings.logAs }).lean();
    holdoutFrom = strat?.holdoutFrom ? Math.floor(new Date(strat.holdoutFrom).getTime() / 1000) : null;
    strategyVersion = strat?.versions?.length ? strat.versions[strat.versions.length - 1].version : 1;
  }
  const run = await StrategyRun.create({ user: userId, apiKey: apiKeyId || null, name, code, settings: { ...settings, holdoutFrom, strategyVersion }, progress: { phase: 'starting' } });
  const runId = String(run._id);
  active.set(runId, { userId: String(userId), cancelled: false });

  const done = (async () => {
    try {
      const result = await execute(runId, userId, code, settings, {
        onProgress: patch => StrategyRun.updateOne({ _id: runId }, { $set: { progress: patch } }).catch(() => {}),
      });
      let trades = result.trades;
      let heldOut = 0;
      if (holdoutFrom != null) {
        heldOut = trades.filter(t => t.entryTime >= holdoutFrom).length;
      }
      let loggedTo = null;
      if (settings.logAs && trades.length && !result.cancelled) {
        try { loggedTo = await logTrades(userId, runId, settings, strategyVersion, trades); }
        catch (err) { console.error('Logging strategy run trades failed:', err.message); loggedTo = { strategy: settings.logAs, error: `Logging to the Backtest Log failed: ${err.message}` }; }
      }
      await StrategyRun.updateOne({ _id: runId }, { $set: {
        status: result.cancelled ? 'cancelled' : 'done',
        trades: trades.map(t => ({ ...t, heldOut: holdoutFrom != null && t.entryTime >= holdoutFrom })),
        heldOutTrades: heldOut, rejected: result.rejected, logs: result.logs, logCount: result.logCount, loggedTo,
        progress: { phase: result.cancelled ? 'cancelled' : 'done', bars: result.bars, seconds: result.seconds, perSymbol: result.perSymbol, approxFills: result.approxFills }, finishedAt: new Date(),
      } });
    } catch (err) {
      if (!(err instanceof AgentError) && !err.code) console.error('Strategy run failed:', err);
      await StrategyRun.updateOne({ _id: runId }, { $set: { status: 'error', error: { message: err.message, code: err.code || 'ERROR' }, finishedAt: new Date() } }).catch(() => {});
    } finally {
      active.delete(runId);
    }
  })();

  if (wait > 0) await Promise.race([done, new Promise(r => setTimeout(r, wait * 1000))]);
  return getRun(userId, runId);
}

async function logTrades(userId, runId, s, version, trades) {
  const list = trades.slice(0, MAX_LOGGED_TRADES);
  const docs = list.map(t => ({
    user: userId,
    name: `${s.logAs} ${new Date(t.entryTime * 1000).toISOString().slice(0, 10)} ${t.symbol} ${t.direction === 'long' ? 'Long' : 'Short'}`.slice(0, 100),
    ...strategyAndTags(s.logAs, [s.logAs]),
    source: 'agent', blind: false, symbol: t.symbol, interval: s.timeframe, direction: t.direction,
    entryTime: t.entryTime, entryPrice: t.entryPrice, exitTime: t.exitTime, exitPrice: t.exitPrice,
    stopLoss: t.stopLoss, takeProfit: t.takeProfit ?? null, outcome: t.outcome, riskAmount: t.riskAmount,
    pnlUSD: t.pnlUSD, rMultiple: t.rMultiple,
    notes: [`Strategy run ${runId}${t.tag ? ` · ${t.tag}` : ''} · exit: ${t.exitReason}`, t.notes, t.finalStopLoss !== t.stopLoss ? `Stop moved from ${t.stopLoss} to ${t.finalStopLoss} during the trade (R is measured from the original stop).` : '', t.partials ? `Partial exits: ${t.partials.map(x => `${Math.round(x.portion * 100)}% at ${x.price} (${x.time})`).join(', ')}; the rest at ${t.exitPrice}.` : ''].filter(Boolean).join('\n\n').slice(0, 5000),
    planFollowed: true,
    features: { ...(t.features || {}), ...(t.tag ? { tag: t.tag } : {}) },
    strategyVersion: version,
  }));
  if (typeof BacktestTrade.insertMany === 'function') await BacktestTrade.insertMany(docs, { ordered: false });
  else for (const d of docs) await BacktestTrade.create(d);
  return { strategy: s.logAs, version, trades: docs.length, ...(trades.length > docs.length ? { notLogged: trades.length - docs.length } : {}) };
}

function summarize(trades) {
  const shaped = trades.map(shape);
  const stats = backtestLog.statsOf(shaped);
  return { ...stats, confidence: confidenceFor(shaped.length, stats.wins, shaped.map(t => t.rMultiple)) };
}
const shape = t => ({ ...t, source: 'agent', tags: t.tag ? [t.tag] : [], strategy: t.tag || null });

async function loadRun(userId, runId) {
  if (!/^[a-f0-9]{24}$/i.test(String(runId || ''))) throw new AgentError('Strategy run not found.', 'NOT_FOUND');
  const run = await StrategyRun.findOne({ _id: runId, user: userId }).lean();
  if (!run) throw new AgentError('Strategy run not found.', 'NOT_FOUND');
  return interrupted(run);
}

const publicTrade = t => ({
  direction: t.direction, entryTime: iso(t.entryTime), entryPrice: round(t.entryPrice), exitTime: iso(t.exitTime), exitPrice: round(t.exitPrice),
  exitReason: t.exitReason, stopLoss: round(t.stopLoss), ...(t.finalStopLoss !== t.stopLoss ? { finalStopLoss: round(t.finalStopLoss) } : {}), takeProfit: round(t.takeProfit),
  rMultiple: round(t.rMultiple, 3), outcome: t.outcome, barsHeld: t.barsHeld, ...(t.tag ? { tag: t.tag } : {}), ...(t.notes ? { notes: t.notes } : {}), features: t.features,
  ...(t.symbol ? { symbol: t.symbol } : {}), ...(t.partials ? { partials: t.partials } : {}), ...(t.approxFill ? { approxFill: true } : {}),
});

async function getRun(userId, runId, { groupBy = [], tradesOffset = 0, tradesLimit = 20 } = {}) {
  const run = await loadRun(userId, runId);
  const s = run.settings || {};
  const out = {
    runId: String(run._id), name: run.name || null, status: run.status,
    settings: { symbols: s.symbols || [s.symbol], timeframe: s.timeframe, maxPositions: s.maxPositions || 1, from: iso(s.from), to: iso(s.to), timeframes: s.timeframes, params: s.params, riskAmount: s.riskAmount, costs: { spread: s.spread, commission: s.commission }, logAs: s.logAs, strategyVersion: s.strategyVersion },
    progress: run.progress,
  };
  if (run.status === 'running') return { ...out, message: 'Still running. Call get_strategy_run again in a little while.' };
  if (run.status === 'error') return { ...out, error: run.error, logs: run.logs };
  const visible = (run.trades || []).filter(t => !t.heldOut);
  out.summary = summarize(visible);
  if (run.heldOutTrades) out.heldOut = `${run.heldOutTrades} trade(s) fall in ${s.logAs}'s held-out period and are left out here. They were logged; judge them once with evaluate_holdout.`;
  const groups = Array.isArray(groupBy) ? groupBy : [groupBy];
  if (groups.length) {
    out.breakdowns = {};
    const shaped = visible.map(shape);
    for (const by of groups) {
      const keysOf = by.startsWith('feature:') ? backtestLog.featureBuckets(shaped, by.slice(8))
        : by === 'tag' ? t => [t.tag || '(none)']
        : by === 'exitReason' ? t => [t.exitReason]
        : by === 'symbol' ? t => [t.symbol]
        : t => backtestLog.groupKeys(t, by);
      const map = new Map();
      for (const t of shaped) for (const k of keysOf(t)) { if (!map.has(k)) map.set(k, []); map.get(k).push(t); }
      out.breakdowns[by] = [...map].map(([k, list]) => ({ [by]: k, ...backtestLog.statsOf(list), confidence: confidenceFor(list.length, list.filter(t => t.outcome === 'win').length, list.map(t => t.rMultiple)) })).sort((a, b) => b.trades - a.trades);
    }
  }
  out.exits = visible.reduce((m, t) => ({ ...m, [t.exitReason]: (m[t.exitReason] || 0) + 1 }), {});
  const limit = Math.max(0, Math.min(200, Math.floor(tradesLimit)));
  const offset = Math.max(0, Math.floor(tradesOffset));
  out.trades = { total: visible.length, offset, items: visible.slice(offset, offset + limit).map(publicTrade) };
  if (run.rejected?.count) out.rejectedActions = run.rejected;
  if (run.progress?.approxFills) out.approxFillsNote = `${run.progress.approxFills} pending-order fill(s) had no 1-minute data (old history), so they were filled at the order price and settled on the base candle, counting a stop inside that candle as hit. Treat those trades as approximate.`;
  if (run.logs?.length) out.logs = run.logs.slice(0, 100);
  if (run.logCount > 100) out.logsNote = `${run.logCount} log lines; the first 100 are shown.`;
  if (run.loggedTo) out.loggedTo = run.loggedTo;
  return out;
}

async function listRuns(userId) {
  const runs = await StrategyRun.find({ user: userId }).select('-code -trades -logs').sort({ createdAt: -1 }).limit(20).lean();
  return {
    runs: runs.map(interrupted).map(r => ({
      runId: String(r._id), name: r.name || null, status: r.status, symbols: r.settings?.symbols || [r.settings?.symbol], timeframe: r.settings?.timeframe,
      from: iso(r.settings?.from), to: iso(r.settings?.to), logAs: r.settings?.logAs || null, createdAt: r.createdAt, progress: r.progress, error: r.error?.message,
    })),
  };
}

async function getRunCode(userId, runId) {
  const run = await loadRun(userId, runId);
  return { runId, code: run.code, params: run.settings?.params || {} };
}

async function cancelRun(userId, runId) {
  const run = await loadRun(userId, runId);
  const a = active.get(String(run._id));
  if (!a) return { cancelled: false, status: run.status, message: 'The run is not running.' };
  a.cancelled = true;
  return { cancelled: true, message: 'It stops at the next candle; trades so far are kept (and not logged).' };
}

// A run marked running that this process isn't running was cut off by a server restart; it can't resume.
function interrupted(run) {
  if (run.status !== 'running' || active.has(String(run._id))) return run;
  const error = { message: 'The server restarted during this run. Start it again.', code: 'INTERRUPTED' };
  StrategyRun.updateOne({ _id: run._id, status: 'running' }, { $set: { status: 'error', error } }).catch(() => {});
  return { ...run, status: 'error', error };
}

module.exports = { startRun, getRun, listRuns, getRunCode, cancelRun, execute, validate, MAX_TRADES };
