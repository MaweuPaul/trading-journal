#!/usr/bin/env node
// Daily FVG Retracement (smc-strategy-lab/daily_fvg) run through the
// TradeJournal MCP backtest tools, one daily bar at a time with the future hidden.
//
//   TJ_MCP_URL=https://your-journal/api/mcp TJ_KEY=tjk_... \
//     node daily_fvg_mcp.js --symbol XAUUSD --from 2020-01-01 --to 2026-09-01
//
// Rules (the strategy README's defaults for gold):
//   1. Bullish D1 FVG: low[i+1] > high[i-1]; known once bar i+1 closes.
//   2. Trigger: the first later D1 bar whose range overlaps [bottom, top].
//      One shot per gap; gaps touched while a trade is open are used up.
//   3. H4 BOS/CHoCH structure (LuxAlgo, pivot size 5) must read bullish.
//   4. Entry: the trigger day's close (the engine buys the next day's first
//      M15 open; through MCP the agent can only enter at the last close).
//   5. Stop: gap bottom - atrMult x D1 ATR14 as of the gap's formation.
//   6. Target: rr x the stop distance. Long only, one trade at a time.
//
// Options: --atr-mult 1.0 --rr 2 --bias on|off --bias-tf 4h --bias-size 5
//          --risk 100 --rpm 110 --no-log
// Node 18+; no dependencies.

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const URL_ = process.env.TJ_MCP_URL;
const KEY = process.env.TJ_KEY;
if (!URL_ || !KEY) { console.error('Set TJ_MCP_URL and TJ_KEY.'); process.exit(1); }
const cfg = {
  symbol: String(args.symbol || 'XAUUSD').toUpperCase(),
  from: args.from || '2020-01-01',
  to: args.to || '2026-09-01',
  atrMult: Number(args['atr-mult'] || 1.0),
  rr: Number(args.rr || 2),
  bias: String(args.bias || 'on') !== 'off',
  biasTf: String(args['bias-tf'] || '4h'),
  biasSize: Number(args['bias-size'] || 5),
  risk: Number(args.risk || 100),
  rpm: Number(args.rpm || 110),
  log: !args['no-log'],
  strategy: args.strategy || 'Daily FVG Retracement',
};
const RULES = `Daily FVG Retracement (smc-strategy-lab). Long only. Bullish D1 fair value gap: low[i+1] > high[i-1], known once bar i+1 closes. `
  + `Buy the first later D1 bar whose range trades back into the gap (one shot per gap; gaps touched during an open trade are used up)`
  + `${cfg.bias ? `, only while ${cfg.biasTf.toUpperCase()} BOS/CHoCH structure (LuxAlgo, pivot size ${cfg.biasSize}) is bullish` : ''}. `
  + `Stop: gap bottom minus the symbol's ATR buffer x D1 ATR14 as of gap formation (1.0 for metals, 0.25 for indices; --atr-mult). Target: ${cfg.rr}R. One trade at a time.`;

// ── MCP client (same as orb_ny_open_mcp.js) ────────────────────────────────
let rpcId = 0;
const callTimes = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (callTimes.length && now - callTimes[0] > 60_000) callTimes.shift();
    if (callTimes.length < cfg.rpm) { callTimes.push(now); return; }
    await sleep(60_000 - (now - callTimes[0]) + 50);
  }
}
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(URL_, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      if (attempt < 6) { process.stdout.write(` [network error: ${err.cause?.code || err.message}; retrying]`); await sleep(5_000 * 2 ** attempt); continue; }
      throw err;
    }
    if ([502, 503, 504].includes(res.status) && attempt < 6) { await sleep(5_000 * 2 ** attempt); continue; }
    if (res.status === 429 && attempt < 30) { await sleep(20_000); continue; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`${method}: HTTP ${res.status} ${JSON.stringify(body.error || body).slice(0, 300)}`);
    return body.result;
  }
}
async function call(name, a = {}) {
  for (let attempt = 0; ; attempt++) {
    const result = await rpc('tools/call', { name, arguments: a });
    const data = JSON.parse(result.content[0].text);
    if (!result.isError) return data;
    if (data.code === 'RATE_LIMITED' && attempt < 20) { process.stdout.write(' [cTrader rate limit, waiting 30s]'); await sleep(30_000); continue; }
    const err = new Error(`${name}: ${data.error}`); err.code = data.code; throw err;
  }
}
const toSec = iso => Date.parse(iso) / 1000;

// ── Indicators ─────────────────────────────────────────────────────────────
/** Wilder ATR14 at each index (null until enough bars). */
function atr14(bars) {
  const out = new Array(bars.length).fill(null);
  let sum = 0, atr = null;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    if (i <= 14) { sum += tr; if (i === 14) atr = sum / 14; }
    else atr = (atr * 13 + tr) / 14;
    out[i] = atr;
  }
  return out;
}
/**
 * LuxAlgo Smart Money Concepts structure trend at the last bar: a swing high
 * at t-len is confirmed when it exceeds the highest high of the len bars
 * after it; the trend turns bullish when a close crosses the last unbroken
 * swing high (BOS/CHoCH), bearish when it crosses the last unbroken swing low.
 */
function structureTrend(bars, len) {
  let os = null, top = null, btm = null, topCrossed = true, btmCrossed = true, trend = 0;
  for (let t = len; t < bars.length; t++) {
    const window = bars.slice(t - len + 1, t + 1);
    const upper = Math.max(...window.map(b => b.high)), lower = Math.min(...window.map(b => b.low));
    const prev = os;
    if (bars[t - len].high > upper) os = 0; else if (bars[t - len].low < lower) os = 1;
    if (os === 0 && prev !== 0) { top = bars[t - len].high; topCrossed = false; }
    if (os === 1 && prev !== 1) { btm = bars[t - len].low; btmCrossed = false; }
    if (top != null && !topCrossed && bars[t].close > top) { trend = 1; topCrossed = true; }
    if (btm != null && !btmCrossed && bars[t].close < btm) { trend = -1; btmCrossed = true; }
  }
  return trend; // 1 bullish, -1 bearish, 0 not yet known
}

// ── The strategy ───────────────────────────────────────────────────────────
(async () => {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'daily-fvg', version: '1' } });
  console.log(`Daily FVG Retracement on ${cfg.symbol}, ${cfg.from} -> ${cfg.to}`, JSON.stringify({ atrMult: cfg.atrMult, rr: cfg.rr, bias: cfg.bias ? `${cfg.biasTf} size ${cfg.biasSize}` : 'off' }));
  if (cfg.log) await call('create_strategy', { name: cfg.strategy, description: RULES.slice(0, 500) });

  const session = await call('start_session', { symbol: cfg.symbol, interval: '1day', from: cfg.from, to: cfg.to, strategy: cfg.log ? cfg.strategy : undefined, context: 300 });
  const sid = session.sessionId;
  const bars = session.candles.map(c => ({ ...c, t: toSec(c.time) }));
  const gaps = []; // { bottom, top, formedAt (index), atr, formedTime }
  const results = [];
  const stats = { gaps: 0, triggers: 0, biasBlocked: 0, invalidStop: 0, usedDuringTrade: 0 };
  let processed = 0;

  // Detect/consume gaps on bars [processed, bars.length). Returns the gap the
  // newest bar triggered (if any, and only when not in a trade).
  function processBars(inTrade) {
    let trigger = null;
    const atr = atr14(bars);
    for (let k = Math.max(processed, 2); k < bars.length; k++) {
      const b = bars[k];
      // 1. Existing gaps touched by this bar are used up (one shot each).
      const touched = gaps.filter(g => !g.used && g.formedAt < k && b.low <= g.top && b.high >= g.bottom);
      for (const g of touched) g.used = true;
      if (touched.length) {
        if (inTrade || k < bars.length - 1) stats.usedDuringTrade += touched.length;
        else trigger = touched[touched.length - 1]; // the most recent gap
      }
      // 2. A new bullish gap completes on this bar.
      if (b.low > bars[k - 2].high && atr[k] != null) {
        gaps.push({ bottom: bars[k - 2].high, top: b.low, formedAt: k, atr: atr[k], formedTime: b.time, used: false });
        stats.gaps++;
      }
    }
    processed = bars.length;
    return trigger;
  }
  processBars(true); // history before the start only seeds gaps
  Object.assign(stats, { gaps: gaps.filter(g => !g.used).length, usedDuringTrade: 0 });

  try {
    for (;;) {
      const s = await call('step', { sessionId: sid, bars: 1 });
      if (!s.candles.length) break;
      for (const c of s.candles) bars.push({ ...c, t: toSec(c.time) });
      const trigger = processBars(false);
      if (s.events.some(e => e.type === 'session_end') && !trigger) break;
      if (!trigger) continue;
      stats.triggers++;

      const k = bars.length - 1, entry = bars[k].close;
      if (cfg.bias) {
        const h = await call('get_candles', { sessionId: sid, timeframe: cfg.biasTf, count: 500 });
        const trend = structureTrend(h.candles, cfg.biasSize);
        if (trend !== 1) { stats.biasBlocked++; continue; }
      }
      const stop = trigger.bottom - cfg.atrMult * trigger.atr;
      if (stop >= entry) { stats.invalidStop++; continue; } // closed below its own stop: no valid setup
      const target = entry + cfg.rr * (entry - stop);
      const features = {
        gapSizeAtr: +((trigger.top - trigger.bottom) / trigger.atr).toFixed(3),
        gapAgeDays: k - trigger.formedAt,
        retraceDepth: +((trigger.top - bars[k].low) / (trigger.top - trigger.bottom)).toFixed(3), // 0 = just touched the top, 1+ = through the bottom
        stopDistAtr: +((entry - stop) / trigger.atr).toFixed(3),
        closeInGap: bars[k].close <= trigger.top,
      };
      await call('open_trade', { sessionId: sid, direction: 'long', stopLoss: stop, takeProfit: target, riskAmount: cfg.risk, features });
      const run = await call('step', { sessionId: sid, bars: 5000 });
      let closed = run.events.find(e => e.type === 'trade_closed')?.trade;
      // Bars revealed during the trade still form and use up gaps.
      const revealed = run.revealed > run.candles.length
        ? (await call('get_candles', { sessionId: sid, timeframe: '1day', count: Math.min(500, run.revealed) })).candles
        : run.candles;
      for (const c of revealed) if (toSec(c.time) > bars[bars.length - 1].t) bars.push({ ...c, t: toSec(c.time) });
      processBars(true);
      if (!closed) {
        if (run.events.some(e => e.type === 'session_end')) { closed = (await call('close_trade', { sessionId: sid })).closed; }
        else break;
      }
      results.push(closed);
      process.stdout.write(`\n${bars[k].time.slice(0, 10)} gap ${trigger.bottom.toFixed(2)}-${trigger.top.toFixed(2)} (formed ${trigger.formedTime.slice(0, 10)}) entry ${entry} -> ${closed.exitReason.padEnd(6)} ${closed.rMultiple >= 0 ? '+' : ''}${closed.rMultiple}R  exit ${closed.exitTime.slice(0, 10)}`);
      if (cfg.log) {
        await call('log_trade', {
          sessionId: sid,
          name: `Daily FVG ${bars[k].time.slice(0, 10)} ${cfg.symbol} Long`,
          notes: `Bullish D1 FVG ${trigger.bottom}-${trigger.top} formed ${trigger.formedTime.slice(0, 10)} (ATR14 ${trigger.atr.toFixed(2)}, stop buffer ${cfg.atrMult} ATR). `
            + `Price traded back into it on ${bars[k].time.slice(0, 10)} (low ${bars[k].low}). ${cfg.bias ? `${cfg.biasTf.toUpperCase()} structure bullish. ` : ''}`
            + `Stop = gap bottom - ${cfg.atrMult} ATR, target ${cfg.rr}R.`,
          planFollowed: true,
          tags: ['FVG', cfg.bias ? `${cfg.biasTf.toUpperCase()} bias` : 'no bias'],
          features,
        });
      } else {
        await call('discard_trade', { sessionId: sid });
      }
      if (run.events.some(e => e.type === 'session_end')) break;
    }
  } finally {
    await call('end_session', { sessionId: sid }).catch(() => {});
  }

  const n = results.length, rs = results.map(r => r.rMultiple);
  const wins = results.filter(r => r.outcome === 'win').length;
  const gw = rs.filter(r => r > 0).reduce((a, b) => a + b, 0), gl = -rs.filter(r => r < 0).reduce((a, b) => a + b, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  console.log('\n\nSummary', JSON.stringify({
    symbol: cfg.symbol, from: cfg.from, to: cfg.to, trades: n,
    winRate: n ? +(wins / n * 100).toFixed(1) : 0, avgR: n ? +(eq / n).toFixed(3) : 0, totalR: +eq.toFixed(2),
    profitFactor: gl ? +(gw / gl).toFixed(2) : null, maxDrawdownR: +dd.toFixed(2), counts: stats,
  }, null, 2));
})().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
