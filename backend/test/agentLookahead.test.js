// Look-ahead bias tests for the MCP agent replay.
//
// The strongest check is a tamper test: run the same deterministic agent over
// two feeds that are identical up to a cut-off time T and completely different
// after it. Everything the agent saw or decided while the replay clock was at
// or before T -- candles, forming candles, entries, exits, R -- must be
// byte-for-byte identical between the two runs. If any of it differs, some
// future data leaked in.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../fixtures/agentReplayHarness');
const replay = require('../lib/agentReplay');

const toSec = iso => Date.parse(iso) / 1000;
const CUTOFF = toSec('2024-02-14T00:00Z');

/** A fixed opening-range-breakout agent: records every response with the clock after it. */
async function runOrbAgent(user) {
  const log = [];
  const rec = (what, res) => { log.push({ what, clock: res.state?.clock ?? res.clock, res }); return res; };
  const s = rec('start', await replay.startSession(user, null, { symbol: 'XAUUSD', interval: '5min', from: '2024-01-08T00:00Z', to: '2024-03-15T00:00Z', context: 20 }));
  const sid = s.sessionId;
  for (let day = toSec('2024-01-08T00:00Z'); day < toSec('2024-03-15T00:00Z'); day += 86400) {
    const wd = new Date(day * 1000).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const iso = t => new Date(t * 1000).toISOString();
    const st = rec('to-range-end', await replay.step(user, sid, { untilTime: iso(day + 13.75 * 3600), stopOnTradeExit: false }));
    if (st.events.some(e => e.type === 'session_end')) break;
    const range = rec('range', await replay.getCandles(user, sid, { count: 3 }));
    // Also exercise the higher-timeframe "forming candle" path.
    for (const tf of ['1h', '4h', '1day']) rec(`view-${tf}`, await replay.getCandles(user, sid, { timeframe: tf, count: 5 }));
    const hi = Math.max(...range.candles.map(c => c.high)), lo = Math.min(...range.candles.map(c => c.low));
    // Alternate the two entry styles so both paths are covered.
    const odd = new Date(day * 1000).getUTCDate() % 2 === 1;
    let dir = null;
    if (odd) {
      // Breakout close via untilCloseAbove/Below, then a market order at the next open.
      const scan = rec('scan-close', await replay.step(user, sid, { untilCloseAbove: hi, untilCloseBelow: lo, untilTime: iso(day + 16 * 3600), stopOnTradeExit: false }));
      const brk = scan.events.find(e => e.type === 'close_beyond');
      if (!brk) continue;
      dir = brk.side === 'above' ? 'long' : 'short';
      rec('order', await replay.openTrade(user, sid, { direction: dir, stopLoss: dir === 'long' ? lo : hi, takeProfitDistance: hi - lo, fill: 'next_open' }));
    } else {
      for (let i = 0; i < 27 && !dir; i++) {
        const c = rec('scan', await replay.step(user, sid, { bars: 1 })).candles.at(-1);
        if (!c) break;
        if (c.close > hi) dir = 'long'; else if (c.close < lo) dir = 'short';
      }
      if (!dir) continue;
      const entry = (await replay.getState(user, sid)).lastCandle.close;
      const stop = dir === 'long' ? lo : hi;
      rec('open', await replay.openTrade(user, sid, { direction: dir, stopLoss: stop, takeProfit: dir === 'long' ? entry + 2 * (entry - stop) : entry - 2 * (stop - entry) }));
    }
    const ex = rec('manage', await replay.step(user, sid, { untilTime: iso(day + 20 * 3600), stopOnTradeExit: true }));
    if (ex.state.pendingOrder || ex.events.some(e => e.type === 'order_cancelled')) { if (ex.state.pendingOrder) rec('cancel', await replay.closeTrade(user, sid)); continue; }
    if (ex.state.openTrade) rec('close', await replay.closeTrade(user, sid));
    if (ex.state.closedTrade || (await replay.getState(user, sid)).closedTrade) rec('log', await replay.logTrade(user, sid, { name: 'orb' }));
  }
  return log;
}

/** Replace every candle that closes after the cut-off with unrelated prices (timestamps kept). */
function tamperAfter(cutoff) {
  const saved = {};
  let seed = 99;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (const [tf, sec] of Object.entries(H.TF)) {
    saved[tf] = H.series[tf].map(c => ({ ...c }));
    for (const c of H.series[tf]) {
      if (c.time + sec <= cutoff) continue;
      const base = 1500 + rnd() * 1000;
      c.open = base; c.close = base + (rnd() - 0.5) * 40;
      c.high = Math.max(c.open, c.close) + rnd() * 30; c.low = Math.min(c.open, c.close) - rnd() * 30;
    }
  }
  return () => { for (const tf of Object.keys(saved)) H.series[tf].splice(0, H.series[tf].length, ...saved[tf]); };
}

const beforeCutoff = log => log.filter(e => e.clock && toSec(e.clock) <= CUTOFF);
// logTrade ids are random; compare what the agent learned, not database ids.
const comparable = entries => JSON.parse(JSON.stringify(entries, (k, v) => (k === 'tradeId' || k === 'sessionId' ? undefined : v)));

test('tamper test: nothing seen before the cut-off depends on data after it', async () => {
  const real = await runOrbAgent(H.newUserId());
  const restore = tamperAfter(CUTOFF);
  let tampered;
  try { tampered = await runOrbAgent(H.newUserId()); } finally { restore(); }

  const a = comparable(beforeCutoff(real));
  const b = comparable(beforeCutoff(tampered));
  assert.ok(a.length > 200, `expected a long transcript before the cut-off, got ${a.length}`);
  assert.equal(b.length, a.length, 'same number of agent steps before the cut-off');
  for (let i = 0; i < a.length; i++) assert.deepEqual(b[i], a[i], `step ${i} (${a[i].what} @ ${a[i].clock}) differs`);

  // Sanity: the tamper really changed what came after, so the test has teeth.
  const after = real.filter(e => e.clock && toSec(e.clock) > CUTOFF).map(e => JSON.stringify(comparable([e])));
  const afterT = tampered.filter(e => e.clock && toSec(e.clock) > CUTOFF).map(e => JSON.stringify(comparable([e])));
  assert.notDeepEqual(afterT, after, 'the tampered run must diverge after the cut-off');
});

test('step until a time the clock has already reached reveals nothing', async () => {
  const user = H.newUserId();
  const s = await replay.startSession(user, null, { symbol: 'XAUUSD', interval: '5min', from: '2024-01-08T00:00Z', to: '2024-01-20T00:00Z', context: 5 });
  const first = await replay.step(user, s.sessionId, { untilTime: '2024-01-08T13:45Z', stopOnTradeExit: false });
  assert.equal(first.state.clock, '2024-01-08T13:45Z');
  const again = await replay.step(user, s.sessionId, { untilTime: '2024-01-08T13:45Z', stopOnTradeExit: false });
  assert.equal(again.revealed, 0);
  assert.equal(again.state.clock, '2024-01-08T13:45Z');
  assert.ok(again.events.some(e => e.type === 'time_reached'));
});
