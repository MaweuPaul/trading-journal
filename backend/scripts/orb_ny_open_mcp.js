#!/usr/bin/env node
// ORB: New York Open (smc-strategy-lab/orb_ny_open) run through the
// TradeJournal MCP backtest tools, bar by bar with the future hidden.
//
//   TJ_MCP_URL=https://your-journal/api/mcp TJ_KEY=tjk_... \
//     node orb_ny_open_mcp.js --symbol XAUUSD --from 2025-06-02 --to 2025-09-01
//
// Options (defaults match the strategy's shipped config):
//   --candle-minutes 5   marking window before 9:30 NY (1 or 5)
//   --monitor-hours 6    how long after the open to watch for a breakout
//   --target-mult 1      measured-move target = this x the range width
//   --bias on|off        daily bias filter (today's range midpoint vs yesterday's)
//   --max-hold-bars 4320 force-close after this many M1 bars
//   --risk 100           USD risked per trade
//   --no-log             don't write trades to the Backtest Log
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
  from: args.from || '2025-06-02',
  to: args.to || '2025-09-01',
  candleMinutes: Number(args['candle-minutes'] || 5),
  monitorHours: Number(args['monitor-hours'] || 6),
  targetMult: Number(args['target-mult'] || 1),
  bias: String(args.bias || 'on') !== 'off',
  maxHoldBars: Number(args['max-hold-bars'] || 4320),
  risk: Number(args.risk || 100),
  log: !args['no-log'],
  strategy: args.strategy || 'ORB NY Open',
};
const STRATEGY_RULES = `ORB New York Open (smc-strategy-lab). Mark the high/low of the M1 candles from ${9}:${30 - cfg.candleMinutes}-9:30 America/New_York (DST-aware). `
  + `After 9:30, take the first M1 close beyond the range within ${cfg.monitorHours}h: above = long, below = short. `
  + `${cfg.bias ? "Daily bias: only longs if today's range midpoint is above yesterday's, only shorts if below. " : ''}`
  + `Enter at the next bar's open (the breakout close). Stop at the opposite side of the range; target ${cfg.targetMult}x the range width from entry. `
  + `One trade per day; force-close after ${cfg.maxHoldBars} M1 bars.`;

// ── MCP client (stateless Streamable HTTP, JSON responses) ─────────────────
let rpcId = 0;
const callTimes = [];
async function throttle() {
  // Stay under the server's 120 requests/minute per key.
  for (;;) {
    const now = Date.now();
    while (callTimes.length && now - callTimes[0] > 60_000) callTimes.shift();
    if (callTimes.length < 110) { callTimes.push(now); return; }
    await sleep(60_000 - (now - callTimes[0]) + 50);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
      // A dropped connection shouldn't end a long run. Note: a retried step may
      // already have run on the server; the replay then just continues from there.
      if (attempt < 6) { process.stdout.write(` [network error: ${err.cause?.code || err.message}; retrying]`); await sleep(5_000 * 2 ** attempt); continue; }
      throw err;
    }
    // Server restarts / gateway hiccups (e.g. a redeploy) are retried too.
    if ([502, 503, 504].includes(res.status) && attempt < 6) { await sleep(5_000 * 2 ** attempt); continue; }
    if (res.status === 429 && attempt < 10) { await sleep(20_000); continue; }
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
    if (data.code === 'RATE_LIMITED' && attempt < 10) { process.stdout.write(' [cTrader rate limit, waiting 30s]'); await sleep(30_000); continue; }
    const err = new Error(`${name}: ${data.error}`); err.code = data.code; throw err;
  }
}

// ── New York time (DST-aware) ──────────────────────────────────────────────
const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function nyOffsetMin(utcMs) {
  const p = Object.fromEntries(nyFmt.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - utcMs) / 60000;
}
/** UTC seconds of 9:30 New York on the given calendar day. */
function nyOpenUtc(y, m, d) {
  const guess = Date.UTC(y, m, d, 9, 30); // as if NY were UTC
  const off = nyOffsetMin(guess + 5 * 3600_000); // -240 (EDT) or -300 (EST)
  return (guess - off * 60_000) / 1000;
}
const toSec = iso => Date.parse(iso) / 1000;
const isoMin = s => new Date(s * 1000).toISOString().slice(0, 16) + 'Z';

// ── The strategy ───────────────────────────────────────────────────────────
(async () => {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'orb-ny-open', version: '1' } });
  // Newer servers can stop a step on the first close beyond a level: one call per day instead of one per bar.
  const tools = (await rpc('tools/list', {})).tools;
  const fastBreakout = Boolean(tools.find(t => t.name === 'step')?.inputSchema?.properties?.untilCloseAbove);
  if (!fastBreakout) console.log('(This server has no untilCloseAbove/untilCloseBelow on step yet: watching bar by bar, which is much slower.)');
  console.log(`ORB NY Open on ${cfg.symbol}, ${cfg.from} -> ${cfg.to}`, JSON.stringify({ candleMinutes: cfg.candleMinutes, monitorHours: cfg.monitorHours, targetMult: cfg.targetMult, bias: cfg.bias }));
  if (cfg.log) await call('create_strategy', { name: cfg.strategy, description: STRATEGY_RULES });

  const session = await call('start_session', { symbol: cfg.symbol, interval: '1min', from: cfg.from, to: cfg.to, strategy: cfg.log ? cfg.strategy : undefined, context: 0 });
  const sid = session.sessionId;
  let clock = toSec(session.clock);
  const results = [];
  let prevMid = null;
  const stats = { days: 0, noData: 0, noBreakout: 0, skippedBusy: 0, filtered: 0 };

  try {
    const start = new Date(cfg.from + 'T00:00:00Z'), end = new Date(cfg.to + 'T00:00:00Z');
    for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
      const wd = d.getUTCDay();
      if (wd === 0 || wd === 6) continue;
      const open = nyOpenUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const markStart = open - cfg.candleMinutes * 60;
      if (clock > markStart) { stats.skippedBusy++; continue; } // yesterday's trade ran into today's range
      stats.days++;

      // 1. Replay up to 9:30 NY, then read the marking candles.
      const toOpen = await call('step', { sessionId: sid, untilTime: isoMin(open), maxBars: 5000 });
      clock = toSec(toOpen.state.clock);
      if (toOpen.events.some(e => e.type === 'session_end')) break;
      const got = await call('get_candles', { sessionId: sid, timeframe: '1min', count: cfg.candleMinutes });
      const marks = got.candles.filter(c => toSec(c.time) >= markStart && toSec(c.time) < open);
      if (marks.length < cfg.candleMinutes || clock < open) { stats.noData++; continue; } // holiday / missing data
      const high = Math.max(...marks.map(c => c.high)), low = Math.min(...marks.map(c => c.low));
      const width = high - low, mid = (high + low) / 2;
      const allowLong = !cfg.bias || (prevMid != null && mid > prevMid);
      const allowShort = !cfg.bias || (prevMid != null && mid < prevMid);
      const biasText = prevMid == null ? 'no previous range' : `mid ${mid.toFixed(2)} vs yesterday ${prevMid.toFixed(2)}`;
      const prevMidForFeature = prevMid;
      prevMid = mid;
      if (width <= 0 || (!allowLong && !allowShort)) { stats.filtered++; continue; }

      // 2. Watch M1 closes after the open for the first allowed close beyond the range.
      const deadline = open + cfg.monitorHours * 3600;
      let breakout = null;
      if (fastBreakout) {
        const s = await call('step', {
          sessionId: sid, maxBars: 5000, untilTime: isoMin(deadline),
          ...(allowLong ? { untilCloseAbove: high } : {}), ...(allowShort ? { untilCloseBelow: low } : {}),
        });
        clock = toSec(s.state.clock);
        const ev = s.events.find(e => e.type === 'close_above' || e.type === 'close_below');
        if (ev) breakout = { direction: ev.type === 'close_above' ? 'long' : 'short', candle: s.candles[s.candles.length - 1] };
        if (!ev && s.events.some(e => e.type === 'session_end')) break;
      }
      while (!fastBreakout && !breakout && clock < deadline) {
        const s = await call('step', { sessionId: sid, bars: 1 });
        clock = toSec(s.state.clock);
        if (s.events.some(e => e.type === 'session_end')) break;
        const c = s.candles[s.candles.length - 1];
        if (!c) continue;
        if (allowLong && c.close > high) breakout = { direction: 'long', candle: c };
        else if (allowShort && c.close < low) breakout = { direction: 'short', candle: c };
      }
      if (!breakout) { stats.noBreakout++; continue; }

      // 3. Enter; stop at the opposite side, measured-move target.
      const long = breakout.direction === 'long';
      const entry = breakout.candle.close;
      // Entry conditions, so results can later be split by them (get_metrics groupBy feature:<name>).
      const features = {
        rangeWidth: +width.toFixed(5),
        rangeWidthPct: +(width / entry * 100).toFixed(4),
        minutesToBreakout: Math.round((toSec(breakout.candle.time) + 60 - open) / 60),
        breakoutBeyondRange: +((long ? entry - high : low - entry) / width).toFixed(3), // how far the close went past the range, in range widths
        ...(prevMidForFeature != null ? { biasGapInRanges: +((mid - prevMidForFeature) / width).toFixed(3) } : {}),
        weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()],
      };
      const opened = await call('open_trade', {
        sessionId: sid, direction: breakout.direction, riskAmount: cfg.risk, features,
        stopLoss: long ? low : high,
        takeProfit: long ? entry + cfg.targetMult * width : entry - cfg.targetMult * width,
      });
      const run = await call('step', { sessionId: sid, bars: cfg.maxHoldBars });
      clock = toSec(run.state.clock);
      let closed = run.events.find(e => e.type === 'trade_closed')?.trade;
      if (!closed) closed = (await call('close_trade', { sessionId: sid })).closed; // max hold reached
      results.push({ day: d.toISOString().slice(0, 10), ...closed, rangeWidth: width });
      process.stdout.write(`\n${d.toISOString().slice(0, 10)} ${breakout.direction.padEnd(5)} entry ${opened.opened.entryPrice} -> ${closed.exitReason.padEnd(6)} ${closed.rMultiple >= 0 ? '+' : ''}${closed.rMultiple}R`);

      if (cfg.log) {
        await call('log_trade', {
          sessionId: sid,
          name: `ORB NY ${d.toISOString().slice(0, 10)} ${cfg.symbol} ${long ? 'Long' : 'Short'}`,
          notes: `Marking range ${cfg.candleMinutes}m before 9:30 NY: high ${high}, low ${low} (width ${width.toFixed(3)}). ${cfg.bias ? `Bias: ${biasText}. ` : ''}`
            + `First M1 close beyond the range at ${breakout.candle.time} (close ${entry}). Stop at the opposite side, target ${cfg.targetMult}x range width.`,
          planFollowed: true,
          tags: ['ORB', `${cfg.candleMinutes}m range`],
        });
      } else {
        await call('discard_trade', { sessionId: sid });
      }
    }
  } finally {
    await call('end_session', { sessionId: sid }).catch(() => {});
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const n = results.length;
  const rs = results.map(r => r.rMultiple);
  const wins = results.filter(r => r.outcome === 'win').length;
  const gw = rs.filter(r => r > 0).reduce((a, b) => a + b, 0), gl = -rs.filter(r => r < 0).reduce((a, b) => a + b, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const summary = {
    symbol: cfg.symbol, from: cfg.from, to: cfg.to, trades: n,
    winRate: n ? +(wins / n * 100).toFixed(1) : 0,
    avgR: n ? +(eq / n).toFixed(3) : 0, totalR: +eq.toFixed(2),
    profitFactor: gl ? +(gw / gl).toFixed(2) : null, maxDrawdownR: +dd.toFixed(2),
    exits: results.reduce((m, r) => ({ ...m, [r.exitReason]: (m[r.exitReason] || 0) + 1 }), {}),
    days: stats,
  };
  console.log('\n\nSummary', JSON.stringify(summary, null, 2));
  if (cfg.log) {
    const m = await call('get_metrics', { strategy: cfg.strategy, symbol: cfg.symbol, groupBy: ['weekday', 'month', 'direction'] });
    console.log('Backtest Log metrics (all agent runs of this strategy on this symbol):', JSON.stringify(m.overall));
    for (const [by, rows] of Object.entries(m.breakdowns)) console.log(`  by ${by}:`, rows.map(r => `${r[by]} n=${r.trades} win=${r.winRate}% avgR=${r.avgR}`).join(' | '));
  }
})().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
