// Execution options for the MCP agent replay: next-open market orders,
// stepping to a breakout close, and gap fills -- each checked against the
// synthetic feed directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../fixtures/agentReplayHarness');
const replay = require('../lib/agentReplay');

const toSec = iso => Date.parse(iso) / 1000;
const bar = (tf, iso) => H.series[tf].find(c => c.time === toSec(iso));
const start = (user, extra = {}) => replay.startSession(user, null, { symbol: 'XAUUSD', interval: '5min', from: '2024-01-09T00:00Z', to: '2024-01-31T00:00Z', context: 5, ...extra });

test('next_open orders fill at the next candle\'s open, with the target as a distance from the fill', async () => {
  const user = H.newUserId();
  const s = await start(user);
  await replay.step(user, s.sessionId, { untilTime: '2024-01-09T10:00Z' });
  const last = (await replay.getState(user, s.sessionId)).lastCandle;
  const placed = await replay.openTrade(user, s.sessionId, { direction: 'long', stopLoss: last.low - 5, takeProfitDistance: 3, fill: 'next_open' });
  assert.equal(placed.pending, true);
  assert.equal(placed.state.openTrade, null);
  assert.equal(placed.state.pendingOrder.fill, 'next_open');
  await assert.rejects(replay.openTrade(user, s.sessionId, { direction: 'long', stopLoss: last.low - 5 }), /already waiting/);

  const res = await replay.step(user, s.sessionId, { bars: 1 });
  const next = bar('5min', '2024-01-09T10:00Z');
  const filled = res.events.find(e => e.type === 'order_filled');
  assert.ok(filled, 'order_filled event');
  assert.equal(filled.trade.entryTime, '2024-01-09T10:00Z');
  assert.ok(Math.abs(filled.trade.entryPrice - next.open) < 1e-4);
  assert.ok(Math.abs(filled.trade.takeProfit - (next.open + 3)) < 1e-4);
});

test('a next_open order whose fill would be beyond the stop is cancelled; close_trade cancels a pending order', async () => {
  const user = H.newUserId();
  const s = await start(user);
  await replay.step(user, s.sessionId, { untilTime: '2024-01-09T10:00Z' });
  const next = bar('5min', '2024-01-09T10:00Z');
  // A long whose stop sits above the next candle's open can't be filled there.
  await replay.openTrade(user, s.sessionId, { direction: 'long', stopLoss: next.open + 0.5, fill: 'next_open' });
  const res = await replay.step(user, s.sessionId, { bars: 1 });
  assert.ok(res.events.some(e => e.type === 'order_cancelled'), 'order_cancelled event');
  assert.equal(res.state.openTrade, null);
  assert.equal(res.state.pendingOrder, null);

  // close_trade cancels an order that hasn't filled yet.
  await replay.openTrade(user, s.sessionId, { direction: 'short', stopLoss: 1e9, fill: 'next_open' });
  const cancelled = await replay.closeTrade(user, s.sessionId);
  assert.equal(cancelled.cancelled, true);
  assert.equal((await replay.getState(user, s.sessionId)).pendingOrder, null);
});

test('untilCloseAbove/Below stops on the first candle that closes beyond the level', async () => {
  const user = H.newUserId();
  const s = await start(user);
  await replay.step(user, s.sessionId, { untilTime: '2024-01-09T12:00Z' });
  const last = (await replay.getState(user, s.sessionId)).lastCandle;
  const above = last.close + 2, below = last.close - 2;
  const res = await replay.step(user, s.sessionId, { untilCloseAbove: above, untilCloseBelow: below, maxBars: 5000 });
  const ev = res.events.find(e => e.type === 'close_beyond');
  assert.ok(ev, 'close_beyond event');
  // Brute force the same answer from the feed.
  const expected = H.series['5min'].find(c => c.time >= toSec('2024-01-09T12:00Z') && (c.close > above || c.close < below));
  assert.equal(ev.candle.time, new Date(expected.time * 1000).toISOString().replace(':00.000Z', 'Z'));
  assert.equal(ev.side, expected.close > above ? 'above' : 'below');
  assert.equal(res.state.clock, new Date((expected.time + 300) * 1000).toISOString().replace(':00.000Z', 'Z'));
});

test('a candle that gaps through the stop fills at its open (or at the stop with gapFills off)', async () => {
  for (const gapFills of [true, false]) {
    // Make the 10:00 5m candle (and its first 1m part) open 3 below a stop
    // placed 1 under the 09:55 close -- before the session caches anything.
    const stop = bar('5min', '2024-01-10T09:55Z').close - 1;
    const next = bar('5min', '2024-01-10T10:00Z');
    const parts = H.series['1min'].filter(c => c.time >= next.time && c.time < next.time + 300);
    const saved = [next, ...parts].map(c => ({ ...c }));
    const gapOpen = stop - 3;
    for (const c of [next, parts[0]]) { c.open = gapOpen; c.low = Math.min(c.low, gapOpen); c.high = Math.max(c.high, gapOpen); }
    try {
      const user = H.newUserId();
      const s = await start(user, { gapFills });
      await replay.step(user, s.sessionId, { untilTime: '2024-01-10T10:00Z' });
      await replay.openTrade(user, s.sessionId, { direction: 'long', stopLoss: stop });
      const res = await replay.step(user, s.sessionId, { bars: 1 });
      const closed = res.events.find(e => e.type === 'trade_closed');
      assert.ok(closed, 'trade closed on the gap candle');
      assert.equal(closed.trade.exitReason, 'stop');
      const want = gapFills ? gapOpen : stop;
      assert.ok(Math.abs(closed.trade.exitPrice - want) < 1e-3, `gapFills=${gapFills}: exit ${closed.trade.exitPrice}, want ${want}`);
      assert.ok(gapFills ? closed.trade.rMultiple < -1 : Math.abs(closed.trade.rMultiple + 1) < 1e-6);
    } finally {
      [next, ...parts].forEach((c, i) => Object.assign(c, saved[i]));
    }
  }
});
