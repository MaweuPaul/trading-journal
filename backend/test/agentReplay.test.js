const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../fixtures/agentReplayHarness');
const replay = require('../lib/agentReplay');

const toSec = iso => Date.parse(iso) / 1000;
function assertNoFuture(candles, clockIso, tf) {
  const clock = toSec(clockIso);
  for (const c of candles) {
    if (!c.forming) assert.ok(toSec(c.time) + H.TF[tf] <= clock, `${tf} candle ${c.time} closes after the clock ${clockIso}`);
  }
}
const start = (user, extra = {}) => replay.startSession(user, null, { symbol: 'XAUUSD', interval: '15min', from: '2024-01-08T00:00Z', to: '2024-03-20T00:00Z', context: 50, ...extra });

test('a session only ever returns candles that closed before the clock', async () => {
  const user = H.newUserId();
  const s = await start(user);
  assert.equal(s.candles.length, 50);
  assertNoFuture(s.candles, s.clock, '15min');

  const stepped = await replay.step(user, s.sessionId, { bars: 10 });
  assert.equal(stepped.revealed, 10);
  assert.equal(toSec(stepped.state.clock), toSec('2024-01-08T02:30Z'));
  assertNoFuture(stepped.candles, stepped.state.clock, '15min');

  for (const tf of ['1min', '5min', '15min', '1h', '4h', '1day']) {
    const got = await replay.getCandles(user, s.sessionId, { timeframe: tf, count: 30 });
    assertNoFuture(got.candles, got.clock, tf);
    const forming = got.candles.find(c => c.forming);
    if (H.TF[tf] > H.TF['15min']) {
      // The forming candle is rebuilt from revealed 15m candles only.
      assert.ok(forming, `forming candle on ${tf}`);
      const parts = H.series['15min'].filter(c => c.time >= toSec(forming.time) && c.time + 900 <= toSec(got.clock));
      assert.ok(Math.abs(forming.high - Math.max(...parts.map(p => p.high))) < 1e-4);
      assert.ok(Math.abs(forming.low - Math.min(...parts.map(p => p.low))) < 1e-4);
      assert.ok(Math.abs(forming.close - parts[parts.length - 1].close) < 1e-4);
    } else {
      assert.equal(forming, undefined, `no forming candle on ${tf}`);
    }
  }
});

test('stop/target resolution matches the 1-minute data, across timeframe switches', async () => {
  const user = H.newUserId();
  const s = await start(user);
  await replay.step(user, s.sessionId, { bars: 10 });
  let resolved = 0;
  for (let i = 0; i < 40; i++) {
    const state = await replay.getState(user, s.sessionId);
    const entry = state.lastCandle.close;
    const long = i % 2 === 0;
    const dist = 1 + (i % 5);
    const trade = { direction: long ? 'long' : 'short', stopLoss: long ? entry - dist : entry + dist, takeProfit: i % 7 === 0 ? undefined : (long ? entry + dist * 1.5 : entry - dist * 1.5) };
    const opened = await replay.openTrade(user, s.sessionId, trade);
    // Switching timeframe mid-trade makes the next candle straddle the clock.
    if (i % 4 === 1) await replay.setTimeframe(user, s.sessionId, ['1h', '4h', '5min', '1day'][(i >> 2) % 4]);
    const res = await replay.step(user, s.sessionId, { bars: 5000 });
    assertNoFuture(res.candles, res.state.clock, res.state.timeframe);
    const closed = res.events.find(e => e.type === 'trade_closed');
    if (closed) {
      resolved++;
      const expected = H.firstLevelOn1m({ ...trade, takeProfit: trade.takeProfit ?? null }, toSec(opened.state.clock), toSec(res.state.clock));
      assert.equal(closed.trade.exitReason, expected, `trade ${i} on ${res.state.timeframe}`);
      await replay.discardTrade(user, s.sessionId);
    } else {
      await replay.closeTrade(user, s.sessionId);
      await replay.discardTrade(user, s.sessionId);
    }
    await replay.setTimeframe(user, s.sessionId, '15min');
  }
  assert.ok(resolved > 20, `only ${resolved} trades hit a level`);
});

test('trade guards, logging, untilPrice and the session end', async () => {
  const user = H.newUserId();
  const s = await start(user, { interval: '1h', from: '2024-02-05T00:00Z', to: '2024-02-10T00:00Z', context: 5, strategy: '#Breakout' });
  const id = s.sessionId;
  await assert.rejects(replay.openTrade(user, id, { direction: 'long', stopLoss: 99999 }), /stop must be below/);
  await assert.rejects(replay.openTrade(user, id, { direction: 'short', stopLoss: 99999, takeProfit: 99999 }), /target must be below/);
  await replay.openTrade(user, id, { direction: 'long', stopLoss: 1 });
  await assert.rejects(replay.openTrade(user, id, { direction: 'long', stopLoss: 1 }), /already open/);
  await assert.rejects(replay.logTrade(user, id, {}), /still open/);
  await replay.closeTrade(user, id);
  await assert.rejects(replay.openTrade(user, id, { direction: 'long', stopLoss: 1 }), /not logged/);

  const logged = await replay.logTrade(user, id, { notes: 'test', tags: ['extra'], setupQuality: 9 });
  const trade = H.models.Trade.store.get(logged.tradeId);
  assert.equal(trade.source, 'agent');
  assert.deepEqual(trade.tags, ['Breakout', 'extra']);
  assert.equal(trade.strategy, 'Breakout');
  assert.equal(trade.setupQuality, 5);
  assert.equal(trade.blind, false);

  const before = await replay.getState(user, id);
  const target = before.lastCandle.close + 3;
  const res = await replay.step(user, id, { untilPrice: target });
  const hit = res.events.find(e => e.type === 'price_reached');
  if (hit) {
    const last = res.candles[res.candles.length - 1];
    assert.ok(last.low <= target && target <= last.high);
  } else {
    assert.ok(res.events.some(e => e.type === 'session_end'));
  }

  const end = await replay.step(user, id, { bars: 5000 });
  assert.ok(end.events.some(e => e.type === 'session_end'));
  const after = await replay.step(user, id, {});
  assert.equal(after.revealed, 0);
  assert.equal(after.events[0].type, 'session_end');

  const ended = await replay.endSession(user, id);
  assert.equal(ended.ended, true);
  await assert.rejects(replay.step(user, id, {}), /ended/);
});

test('start_session validation', async () => {
  const user = H.newUserId();
  await assert.rejects(replay.startSession(user, null, { symbol: 'XAUUSD', from: '2024-01-08', to: '2099-01-01' }), /in the past/);
  await assert.rejects(replay.startSession(user, null, { symbol: 'XAUUSD', from: '2024-01-08' }), /from and to are required/);
  await assert.rejects(replay.startSession(user, null, { symbol: 'XAUUSD', interval: '2h', from: '2024-01-08', to: '2024-01-10' }), /interval must be one of/);
  await assert.rejects(replay.startSession(user, null, { symbol: 'NOPE', from: '2024-01-08', to: '2024-01-10' }), err => err.code === 'SYMBOL_NOT_FOUND');
  await assert.rejects(replay.getState(user, 'not-an-id'), err => err.code === 'NOT_FOUND');
  await assert.rejects(replay.getState(H.newUserId(), (await start(user, { context: 1 })).sessionId), err => err.code === 'NOT_FOUND');
});

test('at most 10 active sessions per user', async () => {
  const user = H.newUserId();
  for (let i = 0; i < 10; i++) await start(user, { context: 1 });
  await assert.rejects(start(user, { context: 1 }), err => err.code === 'TOO_MANY_SESSIONS');
});

test('blind sessions hide the real dates and prices but store real values', async () => {
  const user = H.newUserId();
  const s = await replay.startSession(user, null, { symbol: 'XAUUSD', interval: '15min', blind: true, lengthDays: 10, from: '2024-01-01', to: '2024-03-30', context: 20 });
  assert.equal(s.blind, true);
  assert.match(s.clock, /^1990-01/);
  assert.ok(s.candles.every(c => /^19(89|90)-/.test(c.time)));

  const doc = H.models.Session.store.get(s.sessionId);
  const realLast = H.series['15min'].filter(c => c.time + 900 <= doc.clock).pop();
  const shown = s.candles[s.candles.length - 1];
  assert.ok(Math.abs(shown.close / realLast.close - doc.blind.priceScale) < 1e-4, 'prices are scaled');
  assert.ok(doc.blind.priceScale < 0.86 || doc.blind.priceScale > 1.19, 'scale is far from 1');
  assert.equal(new Date(shown.time).getUTCDay(), new Date(realLast.time * 1000).getUTCDay(), 'weekday survives');
  assert.equal(new Date(shown.time).getUTCHours(), new Date(realLast.time * 1000).getUTCHours(), 'time of day survives');

  const opened = await replay.openTrade(user, s.sessionId, { direction: 'short', stopLoss: shown.close * 1.01, takeProfit: shown.close * 0.99 });
  // A window starting at a weekend enters on the previous Friday: late December 1989.
  assert.match(opened.opened.entryTime, /^19(89|90)-/);
  const stored = H.models.Session.store.get(s.sessionId).openTrade;
  assert.equal(stored.entryPrice, realLast.close);
  assert.ok(Math.abs(stored.stopLoss - realLast.close * 1.01) < 1e-3, 'agent prices map back to real ones');

  const res = await replay.step(user, s.sessionId, { bars: 5000 });
  assert.ok(res.candles.every(c => /^19(89|90)-/.test(c.time)));
  if (res.events.some(e => e.type === 'trade_closed')) {
    const { tradeId } = await replay.logTrade(user, s.sessionId, {});
    const trade = H.models.Trade.store.get(tradeId);
    assert.equal(trade.blind, true);
    assert.equal(trade.entryTime, stored.entryTime);
    assert.match(trade.name, /\(blind\)$/);
  }
});

test('metrics from logged agent trades', async () => {
  const user = H.newUserId();
  for (const [outcome, r] of [['win', 2], ['loss', -1], ['loss', -1], ['win', 1.5], ['breakeven', 0]]) {
    await H.models.Trade.create({ user, source: 'agent', strategy: 'S', tags: ['S'], symbol: 'XAUUSD', interval: '15min', direction: 'long', entryTime: 1, entryPrice: 1, exitTime: 2, exitPrice: 1, stopLoss: 0.5, outcome, rMultiple: r, pnlUSD: r * 100 });
  }
  await H.models.Trade.create({ user, source: 'replay', strategy: 'S', tags: ['S'], symbol: 'XAUUSD', interval: '15min', direction: 'long', entryTime: 1, entryPrice: 1, exitTime: 2, exitPrice: 1, stopLoss: 0.5, outcome: 'win', rMultiple: 5 });
  const m = await replay.getMetrics(user, {});
  assert.equal(m.overall.trades, 5, 'agent source only by default');
  assert.equal(m.overall.winRate, 40);
  assert.equal(m.overall.totalR, 1.5);
  assert.equal(m.overall.profitFactor, 1.75);
  assert.equal(m.overall.maxDrawdownR, 2);
  assert.equal((await replay.getMetrics(user, { source: 'all' })).overall.trades, 6);
  await assert.rejects(replay.getMetrics(user, { source: 'nope' }), /source must be/);
});

test('the candle cache fetches history in blocks, not per step', async () => {
  const user = H.newUserId();
  const s = await start(user, { context: 20 });
  const before = H.fetchLog.length;
  for (let i = 0; i < 50; i++) await replay.step(user, s.sessionId, {});
  assert.ok(H.fetchLog.length - before <= 2, `${H.fetchLog.length - before} fetches for 50 single steps`);
});
