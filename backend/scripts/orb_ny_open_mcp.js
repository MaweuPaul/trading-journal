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
//   --breakout-tf 5min   confirm the breakout on a 5-minute close (default 1min)
//   --retest             enter on a retest of the broken edge (limit order) instead of at the breakout close
//   --retest-expiry-min 60  cancel the retest order if not filled within this many minutes
//   --sweep              liquidity sweep instead of a breakout: wait for a wick beyond one side of the
//                        range and a close back inside, then trade back toward the other side
//   --reclaim-bars 3     sweep: how many candles (of --breakout-tf, 5min by default) price has to close back inside
//   --stop-buffer 0.1    sweep: stop this many range widths beyond the sweep's extreme
//   --sweep-target opposite  sweep: target the opposite side of the range, or a number for a fixed R multiple
//   --min-rr 1           sweep: skip setups whose target is less than this many R away
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
  // Breakout confirmation timeframe: the first 1min (default) or 5min close beyond the range.
  breakoutTf: args['breakout-tf'] === '5min' || (args.sweep && args['breakout-tf'] !== '1min') ? '5min' : '1min',
  // Retest mode: after the breakout, wait for price to come back to the broken
  // edge and buy/sell it there with a limit order (risk = range width, so a
  // 1x-width target pays 1R), cancelled if not filled within retestExpiryMin.
  retest: Boolean(args.retest),
  retestExpiryMin: Number(args['retest-expiry-min'] || 60),
  // Sweep mode: liquidity resting beyond the range gets taken (a wick through it),
  // price closes back inside, and the trade goes the other way.
  sweep: Boolean(args.sweep),
  reclaimBars: Math.max(1, Number(args['reclaim-bars'] || 3)),
  stopBuffer: Number(args['stop-buffer'] ?? 0.1),
  sweepTarget: args['sweep-target'] && args['sweep-target'] !== 'opposite' ? Number(args['sweep-target']) : 'opposite',
  minRR: Number(args['min-rr'] || 1),
};
if (cfg.sweep && cfg.retest) { console.error('Pick --sweep or --retest, not both.'); process.exit(1); }
const TF_SEC = { '1min': 60, '5min': 300 };
const SWEEP_RULES = `ORB NY Open liquidity sweep. Mark the high/low of the M1 candles from 9:${30 - cfg.candleMinutes}-9:30 America/New_York. `
  + `After 9:30 (within ${cfg.monitorHours}h), wait for a wick beyond one side and an ${cfg.breakoutTf === '5min' ? 'M5' : 'M1'} close back inside within ${cfg.reclaimBars} candles. Sweep of the high = short, of the low = long. `
  + `${cfg.bias ? "Bias: only shorts (high sweeps) if today's range midpoint is below yesterday's, only longs if above. " : ''}`
  + `Enter at the reclaim close; stop ${cfg.stopBuffer}x range width beyond the sweep extreme; target ${cfg.sweepTarget === 'opposite' ? 'the opposite side of the range' : `${cfg.sweepTarget}R`}, skipped if under ${cfg.minRR}R. One trade per day.`;
const STRATEGY_RULES = cfg.sweep ? SWEEP_RULES : `ORB New York Open (smc-strategy-lab). Mark the high/low of the M1 candles from ${9}:${30 - cfg.candleMinutes}-9:30 America/New_York (DST-aware). `
  + `After 9:30, take the first ${cfg.breakoutTf === '5min' ? 'M5' : 'M1'} close beyond the range within ${cfg.monitorHours}h: above = long, below = short. `
  + `${cfg.bias ? "Daily bias: only longs if today's range midpoint is above yesterday's, only shorts if below. " : ''}`
  + (cfg.retest
    ? `Then wait up to ${cfg.retestExpiryMin} min for a retest: limit order at the broken edge (range high for longs, low for shorts). Stop at the opposite side of the range; target ${cfg.targetMult}x the range width from the edge (${cfg.targetMult}R). `
    : `Enter at the next bar's open (the breakout close). Stop at the opposite side of the range; target ${cfg.targetMult}x the range width from entry. `)
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
    const text = result.content[0].text;
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`${name}: ${text}`); } // argument validation errors come back as plain text
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
  console.log(`ORB NY Open on ${cfg.symbol}, ${cfg.from} -> ${cfg.to}`, JSON.stringify({ candleMinutes: cfg.candleMinutes, monitorHours: cfg.monitorHours, targetMult: cfg.targetMult, bias: cfg.bias, breakoutTf: cfg.breakoutTf, retest: cfg.retest ? `${cfg.retestExpiryMin} min` : false, sweep: cfg.sweep ? { reclaimBars: cfg.reclaimBars, stopBuffer: cfg.stopBuffer, target: cfg.sweepTarget, minRR: cfg.minRR } : false }));
  const fastSweep = Boolean(tools.find(t => t.name === 'step')?.inputSchema?.properties?.untilHighAbove);
  if (cfg.sweep && !fastSweep) console.log('(This server has no untilHighAbove/untilLowBelow on step yet: watching bar by bar, which is much slower.)');
  if (cfg.log) await call('create_strategy', { name: cfg.strategy, description: STRATEGY_RULES.slice(0, 500) });

  // Sweep runs step in the confirmation timeframe, so the log shows that chart; stops and targets are still settled on 1-minute candles.
  const sessionTf = cfg.sweep ? cfg.breakoutTf : '1min';
  const holdBars = Math.ceil(cfg.maxHoldBars * 60 / TF_SEC[sessionTf]);
  const session = await call('start_session', { symbol: cfg.symbol, interval: sessionTf, from: cfg.from, to: cfg.to, strategy: cfg.log ? cfg.strategy : undefined, context: 0 });
  const sid = session.sessionId;
  let clock = toSec(session.clock);
  const results = [];
  let prevMid = null;
  const stats = { days: 0, noData: 0, noBreakout: 0, noRetest: 0, noSweep: 0, bothSides: 0, noReclaim: 0, lowRR: 0, skippedBusy: 0, filtered: 0 };

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
      const deadline = open + cfg.monitorHours * 3600;

      if (cfg.sweep) {
        // 2s. Wait for a wick beyond an allowed side (high -> short, low -> long).
        const watchHigh = allowShort, watchLow = allowLong;
        let c = null, short = null;
        if (fastSweep) {
          const s = await call('step', { sessionId: sid, maxBars: 5000, untilTime: isoMin(deadline), ...(watchHigh ? { untilHighAbove: high } : {}), ...(watchLow ? { untilLowBelow: low } : {}) });
          clock = toSec(s.state.clock);
          const hi = s.events.some(e => e.type === 'high_above'), lo = s.events.some(e => e.type === 'low_below');
          if (hi && lo) { stats.bothSides++; continue; }
          if (hi || lo) { c = s.candles[s.candles.length - 1]; short = hi; }
          else if (s.events.some(e => e.type === 'session_end')) break;
        }
        while (!fastSweep && !c && clock < deadline) {
          const s = await call('step', { sessionId: sid, bars: 1 });
          clock = toSec(s.state.clock);
          if (s.events.some(e => e.type === 'session_end')) break;
          const k = s.candles[s.candles.length - 1];
          if (!k) continue;
          const hi = watchHigh && k.high > high, lo = watchLow && k.low < low;
          if (hi && lo) { stats.bothSides++; break; }
          if (hi || lo) { c = k; short = hi; }
        }
        if (!c) { if (clock >= deadline) stats.noSweep++; continue; }
        const sweepTime = toSec(c.time);
        // 3s. Price has to close back inside the range within reclaimBars candles.
        let extreme = short ? c.high : c.low, reclaim = null, barsToReclaim = 0;
        for (let k = 0; k < cfg.reclaimBars; k++) {
          if (k > 0) {
            const s = await call('step', { sessionId: sid, bars: 1 });
            clock = toSec(s.state.clock);
            if (s.events.some(e => e.type === 'session_end')) break;
            c = s.candles[s.candles.length - 1];
            extreme = short ? Math.max(extreme, c.high) : Math.min(extreme, c.low);
          }
          barsToReclaim = k + 1;
          if (c.close <= high && c.close >= low) { reclaim = c; break; }
        }
        if (!reclaim) { stats.noReclaim++; continue; }
        const entry = reclaim.close;
        const stop = short ? extreme + cfg.stopBuffer * width : extreme - cfg.stopBuffer * width;
        const risk = Math.abs(stop - entry);
        const target = cfg.sweepTarget === 'opposite' ? (short ? low : high) : (short ? entry - cfg.sweepTarget * risk : entry + cfg.sweepTarget * risk);
        const rr = risk > 0 ? Math.abs(target - entry) / risk : 0;
        if (!(risk > 0) || rr < cfg.minRR || (short ? target >= entry : target <= entry)) { stats.lowRR++; continue; }
        const direction = short ? 'short' : 'long';
        const features = {
          rangeWidth: +width.toFixed(5),
          rangeWidthPct: +(width / entry * 100).toFixed(4),
          sweptSide: short ? 'high' : 'low',
          sweepDepth: +((short ? extreme - high : low - extreme) / width).toFixed(3), // how far the wick went past the range, in range widths
          minutesToSweep: Math.round((sweepTime - open) / 60),
          barsToReclaim,
          plannedRR: +rr.toFixed(2),
          riskInRanges: +(risk / width).toFixed(3),
          ...(prevMidForFeature != null ? { biasGapInRanges: +((mid - prevMidForFeature) / width).toFixed(3) } : {}),
          weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()],
        };
        const opened = await call('open_trade', { sessionId: sid, direction, riskAmount: cfg.risk, features, stopLoss: stop, takeProfit: target });
        const run = await call('step', { sessionId: sid, bars: holdBars });
        clock = toSec(run.state.clock);
        let closed = run.events.find(e => e.type === 'trade_closed')?.trade;
        if (!closed) closed = (await call('close_trade', { sessionId: sid })).closed; // max hold reached
        results.push({ day: d.toISOString().slice(0, 10), ...closed, rangeWidth: width });
        process.stdout.write(`\n${d.toISOString().slice(0, 10)} ${direction.padEnd(5)} sweep ${short ? 'high' : 'low '} entry ${opened.opened.entryPrice} (${rr.toFixed(1)}R to target) -> ${closed.exitReason.padEnd(6)} ${closed.rMultiple >= 0 ? '+' : ''}${closed.rMultiple}R`);
        if (cfg.log) {
          await call('log_trade', {
            sessionId: sid,
            name: `ORB Sweep ${d.toISOString().slice(0, 10)} ${cfg.symbol} ${short ? 'Short' : 'Long'}`,
            notes: `Marking range ${cfg.candleMinutes}m before 9:30 NY: high ${high}, low ${low} (width ${width.toFixed(3)}). ${cfg.bias ? `Bias: ${biasText}. ` : ''}`
              + `Wick beyond the range ${short ? 'high' : 'low'} at ${new Date(sweepTime * 1000).toISOString().slice(0, 16)}Z (extreme ${+extreme.toFixed(5)}, ${features.sweepDepth} range widths past it); `
              + `${cfg.breakoutTf === '5min' ? 'M5' : 'M1'} close back inside at ${reclaim.time} (close ${entry}, ${barsToReclaim} candle${barsToReclaim > 1 ? 's' : ''}). `
              + `Stop ${cfg.stopBuffer}x width beyond the extreme (${+stop.toFixed(5)}), target ${cfg.sweepTarget === 'opposite' ? 'the opposite side of the range' : `${cfg.sweepTarget}R`} (${+target.toFixed(5)}, ${rr.toFixed(2)}R).`,
            planFollowed: true,
          });
        } else {
          await call('discard_trade', { sessionId: sid });
        }
        continue;
      }

      // 2. Watch M1 closes after the open for the first allowed close beyond the range.
      let breakout = null;
      if (cfg.breakoutTf !== '1min') await call('set_timeframe', { sessionId: sid, timeframe: cfg.breakoutTf });
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
      if (cfg.breakoutTf !== '1min') await call('set_timeframe', { sessionId: sid, timeframe: '1min' });
      if (!breakout) { stats.noBreakout++; continue; }

      // 3. Enter; stop at the opposite side, measured-move target.
      const long = breakout.direction === 'long';
      const entry = breakout.candle.close;
      // Entry conditions, so results can later be split by them (get_metrics groupBy feature:<name>).
      const features = {
        rangeWidth: +width.toFixed(5),
        rangeWidthPct: +(width / entry * 100).toFixed(4),
        minutesToBreakout: Math.round((toSec(breakout.candle.time) + TF_SEC[cfg.breakoutTf] - open) / 60),
        breakoutTf: cfg.breakoutTf,
        entryMode: cfg.retest ? 'retest' : 'breakout close',
        breakoutBeyondRange: +((long ? entry - high : low - entry) / width).toFixed(3), // how far the close went past the range, in range widths
        ...(prevMidForFeature != null ? { biasGapInRanges: +((mid - prevMidForFeature) / width).toFixed(3) } : {}),
        weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()],
      };
      let opened, run;
      if (cfg.retest) {
        // Limit order back at the broken edge; stop at the opposite side, target 1x width from the edge.
        const edge = long ? high : low;
        const placed = await call('place_order', {
          sessionId: sid, type: 'limit', direction: breakout.direction, price: edge, riskAmount: cfg.risk, features,
          stopLoss: long ? low : high,
          takeProfit: long ? edge + cfg.targetMult * width : edge - cfg.targetMult * width,
          expiresAt: isoMin(clock + cfg.retestExpiryMin * 60),
        });
        opened = { opened: { entryPrice: placed.placed.price } };
        run = await call('step', { sessionId: sid, bars: cfg.maxHoldBars });
        clock = toSec(run.state.clock);
        if (run.events.some(e => e.type === 'order_expired')) { stats.noRetest++; continue; }
        const fill = run.events.find(e => e.type === 'order_filled');
        if (fill) opened.opened.entryPrice = fill.trade.entryPrice;
      } else {
        opened = await call('open_trade', {
          sessionId: sid, direction: breakout.direction, riskAmount: cfg.risk, features,
          stopLoss: long ? low : high,
          takeProfit: long ? entry + cfg.targetMult * width : entry - cfg.targetMult * width,
        });
        run = await call('step', { sessionId: sid, bars: cfg.maxHoldBars });
        clock = toSec(run.state.clock);
      }
      let closed = run.events.find(e => e.type === 'trade_closed')?.trade;
      if (!closed) closed = (await call('close_trade', { sessionId: sid })).closed; // max hold reached
      results.push({ day: d.toISOString().slice(0, 10), ...closed, rangeWidth: width });
      process.stdout.write(`\n${d.toISOString().slice(0, 10)} ${breakout.direction.padEnd(5)} entry ${opened.opened.entryPrice} -> ${closed.exitReason.padEnd(6)} ${closed.rMultiple >= 0 ? '+' : ''}${closed.rMultiple}R`);

      if (cfg.log) {
        await call('log_trade', {
          sessionId: sid,
          name: `ORB NY ${d.toISOString().slice(0, 10)} ${cfg.symbol} ${long ? 'Long' : 'Short'}`,
          notes: `Marking range ${cfg.candleMinutes}m before 9:30 NY: high ${high}, low ${low} (width ${width.toFixed(3)}). ${cfg.bias ? `Bias: ${biasText}. ` : ''}`
            + `First ${cfg.breakoutTf === '5min' ? 'M5' : 'M1'} close beyond the range at ${breakout.candle.time} (close ${entry}). `
            + `${cfg.retest ? `Entered on the retest of the broken edge (limit ${opened.opened.entryPrice}, ${cfg.retestExpiryMin} min to fill). ` : ''}`
            + `Stop at the opposite side, target ${cfg.targetMult}x range width${cfg.retest ? ' from the edge' : ''}.`,
          planFollowed: true,
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
