const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../fixtures/agentReplayHarness');
const replay = require('../lib/agentReplay');

const toSec = iso => Date.parse(iso) / 1000;
const start = (user, extra = {}) => replay.startSession(user, null, { symbol: 'XAUUSD', interval: '15min', from: '2024-01-08T00:00Z', to: '2024-03-20T00:00Z', context: 20, ...extra });

/** Brute force on 1m data: fill (gap -> open), stop-only in the fill minute, then stop/target. */
function orderTruth(o, fromSec, untilSec) {
  const long = o.direction === 'long';
  let entry = null;
  for (const m of H.series['1min']) {
    if (m.time < fromSec || m.time >= untilSec) continue;
    if (entry == null) {
      const touched = o.type === 'limit' ? (long ? m.low <= o.price : m.high >= o.price) : (long ? m.high >= o.price : m.low <= o.price);
      if (!touched) continue;
      const gapped = o.type === 'limit' ? (long ? m.open < o.price : m.open > o.price) : (long ? m.open > o.price : m.open < o.price);
      entry = gapped ? m.open : o.price;
      if (long ? entry <= o.stopLoss : entry >= o.stopLoss) return { entry, exit: 'stop' };
      if (long ? m.low <= o.stopLoss : m.high >= o.stopLoss) return { entry, exit: 'stop' };
      continue;
    }
    if (long ? m.low <= o.stopLoss : m.high >= o.stopLoss) return { entry, exit: 'stop' };
    if (o.takeProfit != null && (long ? m.high >= o.takeProfit : m.low <= o.takeProfit)) return { entry, exit: 'target' };
  }
  return entry == null ? null : { entry, exit: null };
}

test('pending limit/stop orders fill and exit exactly as the 1-minute data says', async () => {
  const user = H.newUserId();
  const s = await start(user);
  let filled = 0;
  for (let i = 0; i < 40; i++) {
    const state = await replay.getState(user, s.sessionId);
    const now = state.lastCandle.close;
    const type = i % 2 ? 'limit' : 'stop';
    const long = i % 4 < 2;
    const off = 1 + (i % 3);
    // limit: better price (below for long); stop: breakout (above for long)
    const price = type === 'limit' ? (long ? now - off : now + off) : (long ? now + off : now - off);
    const order = { type, direction: long ? 'long' : 'short', price, stopLoss: long ? price - 2 : price + 2, takeProfit: long ? price + 3 : price - 3 };
    const placedAt = toSec(state.clock);
    await replay.placeOrder(user, s.sessionId, { ...order, expiresAfterBars: 96 });
    if (i % 5 === 2) await replay.setTimeframe(user, s.sessionId, '1h'); // fills inside straddling candles
    const res = await replay.step(user, s.sessionId, { bars: 3000 });
    const expired = res.events.find(e => e.type === 'order_expired');
    if (res.events.some(e => e.type === 'session_end') && !res.events.some(e => e.type === 'order_filled')) break;
    const fill = res.events.find(e => e.type === 'order_filled');
    const expiry = placedAt + 96 * 900;
    const truth = orderTruth(order, placedAt, fill ? toSec(res.state.clock) : expiry);
    if (expired) {
      assert.equal(truth, null, `order ${i} expired but the 1m data fills it`);
    } else {
      assert.ok(fill, `order ${i}: neither filled nor expired`);
      filled++;
      assert.ok(Math.abs(fill.trade.entryPrice - Number(truth.entry.toFixed(5))) < 1e-4, `order ${i} fill price`);
      const closed = res.events.find(e => e.type === 'trade_closed');
      assert.equal(closed?.trade.exitReason ?? null, truth.exit, `order ${i} exit`);
      if (closed) await replay.discardTrade(user, s.sessionId);
      else { await replay.closeTrade(user, s.sessionId); await replay.discardTrade(user, s.sessionId); }
    }
    await replay.setTimeframe(user, s.sessionId, '15min');
  }
  assert.ok(filled > 15, `only ${filled} orders filled`);
});

test('order validation, cancel and modify', async () => {
  const user = H.newUserId();
  const s = await start(user);
  const now = (await replay.getState(user, s.sessionId)).lastCandle.close;
  await assert.rejects(replay.placeOrder(user, s.sessionId, { type: 'limit', direction: 'long', price: now + 1, stopLoss: now - 5 }), /must be below the current price/);
  await assert.rejects(replay.placeOrder(user, s.sessionId, { type: 'stop', direction: 'long', price: now - 1, stopLoss: now - 5 }), /must be above the current price/);
  await assert.rejects(replay.placeOrder(user, s.sessionId, { type: 'limit', direction: 'long', price: now - 1, stopLoss: now }), /stop must be below/);
  await replay.placeOrder(user, s.sessionId, { type: 'limit', direction: 'long', price: now - 50, stopLoss: now - 55 });
  await assert.rejects(replay.openTrade(user, s.sessionId, { direction: 'long', stopLoss: now - 5 }), /pending order/);
  const moved = await replay.modifyTrade(user, s.sessionId, { price: now - 60, stopLoss: now - 62 });
  assert.equal(moved.modified.price, Number((now - 60).toFixed(5)));
  assert.equal((await replay.getState(user, s.sessionId)).pendingOrder.stopLoss, Number((now - 62).toFixed(5)));
  await replay.cancelOrder(user, s.sessionId);
  await assert.rejects(replay.cancelOrder(user, s.sessionId), /no pending order/);
  await assert.rejects(replay.modifyTrade(user, s.sessionId, { stopLoss: 1 }), /no open trade or pending order/);
});

test('moving the stop to breakeven: R stays measured from the original stop', async () => {
  const user = H.newUserId();
  const s = await start(user);
  let checked = 0;
  for (let i = 0; i < 30 && checked < 8; i++) {
    const st = await replay.getState(user, s.sessionId);
    const entry = st.lastCandle.close;
    await replay.openTrade(user, s.sessionId, { direction: 'long', stopLoss: entry - 4, takeProfit: entry + 8 });
    // Wait for price to move 2 above entry, then trail the stop to entry.
    const run = await replay.step(user, s.sessionId, { untilPrice: entry + 2 });
    if (run.events.some(e => e.type === 'trade_closed')) { await replay.discardTrade(user, s.sessionId); continue; }
    const now = run.state.lastCandle.close;
    if (now <= entry) { await replay.closeTrade(user, s.sessionId); await replay.discardTrade(user, s.sessionId); continue; }
    await assert.rejects(replay.modifyTrade(user, s.sessionId, { stopLoss: now + 1 }), /must stay below/);
    const mod = await replay.modifyTrade(user, s.sessionId, { stopLoss: entry });
    assert.equal(mod.modified.initialStopLoss, Number((entry - 4).toFixed(5)));
    const modClock = toSec(run.state.clock);
    const res = await replay.step(user, s.sessionId, { bars: 5000 });
    const closed = res.events.find(e => e.type === 'trade_closed');
    if (!closed) break;
    const truth = H.firstLevelOn1m({ direction: 'long', stopLoss: entry, takeProfit: entry + 8 }, modClock, toSec(res.state.clock));
    assert.equal(closed.trade.exitReason, truth);
    if (truth === 'stop') { assert.equal(closed.trade.rMultiple, 0); assert.equal(closed.trade.outcome, 'breakeven'); }
    else { assert.equal(closed.trade.rMultiple, 2); assert.equal(closed.trade.outcome, 'win'); }
    // Logged with the original stop, and a note that it moved.
    const { tradeId } = await replay.logTrade(user, s.sessionId, { notes: 'trailed' });
    const logged = H.models.Trade.store.get(tradeId);
    assert.equal(logged.stopLoss, entry - 4);
    assert.match(logged.notes, /^trailed\n\nStop moved from/);
    checked++;
  }
  assert.ok(checked >= 3, `only ${checked} trades reached the breakeven move`);
});

test('indicators use closed candles only and match independent calculations', async () => {
  const user = H.newUserId();
  const s = await start(user);
  await replay.step(user, s.sessionId, { bars: 300 });
  const res = await replay.getIndicators(user, s.sessionId, { timeframe: '1h', indicators: ['ema:20', 'sma:10', 'rsi:14', 'atr:14', 'bb:20:2'], count: 30 });
  assert.equal(res.values.length, 30);
  const clock = toSec(res.clock);
  const closed = H.series['1h'].filter(c => c.time + 3600 <= clock);
  const last = res.values[res.values.length - 1];
  assert.equal(toSec(last.time), closed[closed.length - 1].time, 'last row is the last closed candle');
  const closes = closed.map(c => c.close);
  const sma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  assert.ok(Math.abs(last.sma_10 - sma10) < 1e-4, 'sma');
  const mid = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(closes.slice(-20).reduce((a, b) => a + (b - mid) ** 2, 0) / 20);
  assert.ok(Math.abs(last.bb_20_2_upper - (mid + 2 * sd)) < 1e-4, 'bollinger upper');
  // EMA over the whole revealed history vs. over the warm-up window agree closely.
  const k = 2 / 21; let e = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  for (let i = 20; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  assert.ok(Math.abs(last.ema_20 - e) < 0.05, `ema ${last.ema_20} vs ${e}`);
  assert.ok(last.rsi_14 > 0 && last.rsi_14 < 100);
  assert.ok(last.atr_14 > 0);
  await assert.rejects(replay.getIndicators(user, s.sessionId, { indicators: ['macd'] }), /Unknown indicator/);
});

test('blind sessions: orders and indicators use the shown (rescaled) prices', async () => {
  const user = H.newUserId();
  const s = await replay.startSession(user, null, { symbol: 'XAUUSD', blind: true, lengthDays: 10, from: '2024-01-01', to: '2024-03-30', context: 60 });
  const scale = H.models.Session.store.get(s.sessionId).blind.priceScale;
  const shown = s.candles[s.candles.length - 1].close;
  await replay.placeOrder(user, s.sessionId, { type: 'limit', direction: 'long', price: shown * 0.99, stopLoss: shown * 0.98 });
  const stored = H.models.Session.store.get(s.sessionId).pendingOrder;
  assert.ok(Math.abs(stored.price - (shown * 0.99) / scale) < 1e-6, 'order price mapped back to real');
  const ind = await replay.getIndicators(user, s.sessionId, { indicators: ['sma:5'], count: 1 });
  assert.match(ind.values[0].time, /^19(89|90)-/);
  const realCloses = H.series['15min'].filter(c => c.time + 900 <= H.models.Session.store.get(s.sessionId).clock).slice(-5).map(c => c.close);
  assert.ok(Math.abs(ind.values[0].sma_5 / (realCloses.reduce((a, b) => a + b, 0) / 5) - scale) < 1e-4, 'sma rescaled');
});

test('step stops on the first candle that closes beyond a level', async () => {
  const user = H.newUserId();
  const s = await start(user);
  for (let i = 0; i < 20; i++) {
    const st = await replay.getState(user, s.sessionId);
    const now = st.lastCandle.close;
    const above = now + 2, below = now - 2;
    const from = toSec(st.clock);
    const res = await replay.step(user, s.sessionId, { untilCloseAbove: above, untilCloseBelow: below });
    const truth = H.series['15min'].find(c => c.time >= from && (c.close > above || c.close < below));
    const ev = res.events.find(e => e.type === 'close_above' || e.type === 'close_below');
    assert.ok(ev, `run ${i}: no close event`);
    assert.equal(toSec(ev.time), truth.time, `run ${i}: stopped on the wrong candle`);
    assert.equal(ev.type, truth.close > above ? 'close_above' : 'close_below');
    assert.equal(toSec(res.state.clock), truth.time + 900);
  }
  await assert.rejects(replay.step(user, s.sessionId, { untilCloseAbove: 'x' }), /must be numbers/);
});

test('step stops on the first wick beyond a level (sweeps), reporting both sides when one candle takes both', async () => {
  const user = H.newUserId();
  const s = await start(user);
  for (let i = 0; i < 20; i++) {
    const st = await replay.getState(user, s.sessionId);
    const now = st.lastCandle.close;
    const above = now + 1.5, below = now - 1.5;
    const from = toSec(st.clock);
    const res = await replay.step(user, s.sessionId, { untilHighAbove: above, untilLowBelow: below });
    const truth = H.series['15min'].find(c => c.time >= from && (c.high > above || c.low < below));
    const types = res.events.filter(e => e.type === 'high_above' || e.type === 'low_below').map(e => e.type);
    assert.deepEqual(types, [...(truth.high > above ? ['high_above'] : []), ...(truth.low < below ? ['low_below'] : [])], `run ${i}`);
    assert.equal(toSec(res.state.clock), truth.time + 900, `run ${i}: stopped on the wrong candle`);
  }
  await assert.rejects(replay.step(user, s.sessionId, { untilHighAbove: 'x' }), /must be numbers/);
});
