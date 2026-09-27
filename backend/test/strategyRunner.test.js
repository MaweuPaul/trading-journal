const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../fixtures/agentReplayHarness');
const runner = require('../lib/strategyRunner');

const base = { symbol: 'XAUUSD', timeframe: '15min', from: '2024-01-08', to: '2024-02-10', warmupBars: 50 };
async function run(user, code, extra = {}) {
  const res = await runner.startRun(user, null, { ...base, code, ...extra }, { wait: 50 });
  assert.notEqual(res.status, 'running', 'finished within the wait');
  return res;
}
async function all(user, res) {
  const out = [];
  for (;;) {
    const page = (await runner.getRun(user, res.runId, { tradesOffset: out.length, tradesLimit: 200 })).trades;
    out.push(...page.items);
    if (out.length >= page.total || !page.items.length) return out;
  }
}
const toSec = iso => Date.parse(iso) / 1000;

test('market entries: every exit matches the 1-minute truth', async () => {
  const user = H.newUserId();
  const code = `
    function onBar(ctx) {
      if (ctx.position || ctx.time.utc.minute !== 0) return;
      const c = ctx.bar.close;
      if (ctx.time.utc.hour % 2) ctx.buy({ stop: c - 1.2, target: c + 1.5, tag: 'odd' });
      else ctx.sell({ stop: c + 1.2, target: c - 1.5, tag: 'even' });
    }`;
  const res = await run(user, code);
  assert.equal(res.status, 'done', JSON.stringify(res.error));
  const trades = await all(user, res);
  assert.ok(trades.length > 50, `${trades.length} trades`);
  for (const t of trades.filter(t => t.exitReason !== 'end')) {
    const entryClose = toSec(t.entryTime) + 900;
    const truth = H.firstLevelOn1m({ direction: t.direction, stopLoss: t.stopLoss, takeProfit: t.takeProfit }, entryClose, Infinity);
    assert.equal(t.exitReason, truth, `${t.entryTime} ${t.direction}`);
    assert.equal(t.rMultiple, t.exitReason === 'stop' ? -1 : 1.25);
  }
  assert.equal(res.summary.trades, trades.length);
  assert.ok(res.summary.confidence.level);
  const byTag = (await runner.getRun(user, res.runId, { groupBy: ['tag'] })).breakdowns.tag.map(g => g.tag).sort();
  assert.deepEqual(byTag, ['even', 'odd']);
});

test('daily strategies settle on 1-hour candles, never fetching 1-minute data', async () => {
  const user = H.newUserId();
  // Stop and target close to the entry, so most days touch both.
  const code = `
    function onBar(ctx) {
      if (ctx.position) return;
      const c = ctx.bar.close;
      ctx.buy({ stop: c - 3, target: c + 3 });
    }`;
  const before = H.fetchLog.length;
  const res = await run(user, code, { timeframe: '1day', from: '2024-01-15', to: '2024-03-25', warmupBars: 5 });
  assert.equal(res.status, 'done', JSON.stringify(res.error));
  const trades = await all(user, res);
  assert.ok(trades.length > 10, `${trades.length} trades`);
  const fetched = new Set(H.fetchLog.slice(before).map(([tf]) => tf));
  for (const fine of ['1min', '5min', '15min']) assert.equal(fetched.has(fine), false, `fetched ${fine}`);
  assert.ok(fetched.has('1h'), 'settled on 1h candles');
  for (const t of trades.filter(t => t.exitReason !== 'end')) assert.ok(['stop', 'target'].includes(t.exitReason));
});

test('the code never sees a candle that has not closed, on any timeframe', async () => {
  const user = H.newUserId();
  const code = `
    function onBar(ctx) {
      const now = ctx.time.unix;
      const s = ctx.series();
      if (s.time[s.time.length - 1] + 900 !== now) ctx.log('base ahead', s.time[s.time.length - 1]);
      for (const tf of ['1h', '4h']) {
        const c = ctx.candle(0, tf);
        if (c && c.time + (tf === '1h' ? 3600 : 14400) > now) ctx.log('closed ' + tf + ' ahead');
        const f = ctx.forming(tf);
        if (f && (f.time > now || f.time + (tf === '1h' ? 3600 : 14400) <= now)) ctx.log('forming ' + tf + ' wrong');
      }
      if (ctx.ema(10, { tf: '1h' }) == null && ctx.index > 100) ctx.log('ema missing');
    }`;
  const res = await run(user, code, { timeframes: ['1h', '4h'] });
  assert.equal(res.status, 'done', JSON.stringify(res.error));
  assert.equal(res.logs, undefined, JSON.stringify(res.logs));
});

test('forming higher-timeframe candle matches the aggregated closed base candles', async () => {
  const user = H.newUserId();
  const code = `
    function onBar(ctx) {
      const f = ctx.forming('1h');
      if (!f) return;
      const bars = ctx.bars(4).filter(b => b.time >= f.time);
      const hi = Math.max(...bars.map(b => b.high)), lo = Math.min(...bars.map(b => b.low));
      if (Math.abs(hi - f.high) > 1e-9 || Math.abs(lo - f.low) > 1e-9 || bars[0].open !== f.open || ctx.bar.close !== f.close) ctx.log('mismatch', f, bars);
    }`;
  const res = await run(user, code, { timeframes: ['1h'], to: '2024-01-20' });
  assert.equal(res.logs, undefined, JSON.stringify(res.logs));
});

test('limit orders fill on 1-minute data or expire; bad actions are rejected, not fatal', async () => {
  const user = H.newUserId();
  const code = `
    function onBar(ctx) {
      for (const e of ctx.events) if (e.type === 'expired') ctx.state.expired = (ctx.state.expired || 0) + 1;
      if (ctx.position || ctx.order || ctx.time.utc.minute !== 0) return;
      const c = ctx.bar.close;
      ctx.buyLimit(c - 0.6, { stop: c - 2, target: c + 1, expiresInBars: 2 });
      ctx.buy({ stop: c + 1 }); // rejected: order already pending, and stop above entry
    }
    function onEnd(ctx) { ctx.log('expired', ctx.state.expired || 0); }`;
  const res = await run(user, code, { to: '2024-01-25' });
  assert.equal(res.status, 'done', JSON.stringify(res.error));
  assert.ok(res.trades.total > 5);
  assert.ok(res.rejectedActions.count > 5);
  assert.match(res.logs[0], /expired [1-9]/);
  for (const t of (await all(user, res)).filter(t => t.exitReason !== 'end')) {
    const truth = H.firstLevelOn1m({ direction: 'long', stopLoss: t.stopLoss, takeProfit: t.takeProfit }, toSec(t.entryTime) + 60, Infinity);
    // In the fill minute only the stop counts; after it, the 1-minute truth.
    if (truth) assert.ok(t.exitReason === truth || t.exitReason === 'stop', `${t.entryTime}`);
  }
});

test('costs: spread moves entries against you, commission comes off R', async () => {
  const user = H.newUserId();
  const code = `function onBar(ctx) { if (!ctx.position && ctx.time.utc.hour === 10 && ctx.time.utc.minute === 0) ctx.buy({ stop: ctx.bar.close - 2, target: ctx.bar.close + 2 }); }`;
  const plain = await all(user, await run(user, code, { to: '2024-01-20' }));
  const costly = await all(user, await run(user, code, { to: '2024-01-20', costs: { spread: 0.2, commission: 10 } }));
  assert.equal(plain.length, costly.length);
  assert.ok(Math.abs(costly[0].entryPrice - plain[0].entryPrice - 0.2) < 1e-6);
  assert.ok(costly.every((t, i) => t.rMultiple < plain[i].rMultiple));
});

test('code errors come back with a message; endless loops are stopped', async () => {
  const user = H.newUserId();
  await assert.rejects(runner.startRun(user, null, { ...base, code: 'function onBar(ctx) { ' }), /SyntaxError/);
  await assert.rejects(runner.startRun(user, null, { ...base, code: 'function nope() {}' }), /Define function onBar/);
  const boom = await run(user, 'function onBar(ctx) { if (ctx.index === 3) null.x; }');
  assert.equal(boom.status, 'error');
  assert.match(boom.error.message, /TypeError/);
  const loop = await run(user, 'function onBar(ctx) { if (ctx.index === 2) for (;;) {} }', { to: '2024-01-10' });
  assert.equal(loop.status, 'error');
  assert.match(loop.error.message, /longer than/);
  const sneaky = await run(user, 'function onBar(ctx) { if (typeof require !== "undefined" || typeof process !== "undefined" || typeof fetch !== "undefined") ctx.log("escape"); }', { to: '2024-01-10' });
  assert.equal(sneaky.logs, undefined, 'no host objects in the sandbox');
});

test('logAs logs agent trades with the rules version; held-out trades stay hidden', async () => {
  const user = H.newUserId();
  await H.models.Strategy.create({ user, name: 'EMA test', holdoutFrom: new Date('2024-02-01'), versions: [{ version: 1, rules: 'a' }, { version: 2, rules: 'b' }] });
  const code = `function onBar(ctx) { if (!ctx.position && ctx.time.utc.minute === 0 && ctx.time.utc.hour === 14) ctx.buy({ stop: ctx.bar.close - 1, target: ctx.bar.close + 1, features: { hour: 14 } }); }`;
  const res = await run(user, code, { logAs: 'EMA test' });
  const logged = [...H.models.Trade.store.values()].filter(t => String(t.user) === user);
  assert.equal(logged.length, res.loggedTo.trades);
  assert.ok(logged.every(t => t.source === 'agent' && t.strategyVersion === 2 && t.features.hour === 14 && t.features.atr14 > 0));
  assert.ok(res.heldOut, 'held-out note');
  const visible = await all(user, res);
  assert.ok(visible.every(t => t.entryTime < '2024-02-01'));
  assert.ok(logged.length > visible.length);
});

test('over MCP: strategy_api, run_strategy and get_strategy_run', async () => {
  const express = require('express');
  const crypto = require('crypto');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', require('../routes/mcp'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const user = H.newUserId();
    const key = `tjk_${crypto.randomBytes(8).toString('hex')}`;
    await H.models.ApiKey.create({ user, name: 't', keyHash: crypto.createHash('sha256').update(key).digest('hex'), prefix: key.slice(0, 10) });
    let id = 0;
    const call = async (name, args) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      });
      const body = await res.json();
      assert.equal(body.error, undefined, JSON.stringify(body.error));
      return JSON.parse(body.result.content[0].text);
    };
    assert.match((await call('strategy_api', {})).reference, /function onBar\(ctx\)/);
    const res = await call('run_strategy', { ...base, to: '2024-01-20', code: 'function onBar(ctx) { if (!ctx.position && ctx.time.ny.hour === 10 && ctx.time.ny.minute === 0) ctx.buy({ stop: ctx.bar.close - 1, target: ctx.bar.close + 2 }); }', wait: 30 });
    assert.equal(res.status, 'done', JSON.stringify(res));
    assert.ok(res.summary.trades > 0);
    const again = await call('get_strategy_run', { runId: res.runId, groupBy: ['weekday'] });
    assert.ok(again.breakdowns.weekday.length > 0);
    // 10:00 New York is 15:00 UTC in January.
    assert.ok(again.trades.items.every(t => new Date(Date.parse(t.entryTime) + 900_000).getUTCHours() === 15));
    assert.equal((await call('list_strategy_runs', {})).runs[0].runId, res.runId);
    assert.match((await call('get_strategy_run_code', { runId: res.runId })).code, /onBar/);
  } finally {
    server.close();
  }
});

test('trend indicators: streaming values match the array functions; ADX/MACD/Donchian sane', async () => {
  const user = H.newUserId();
  const code = `
    function near(a, b) { return a == null ? b == null : Math.abs(a - b) < 1e-7; }
    function onBar(ctx) {
      const s = ctx.series(), c = s.close, n = c.length;
      const checks = {
        sma: [ctx.sma(20), ctx.ta.sma(c, 20)[n - 1]],
        ema: [ctx.ema(30), ctx.ta.ema(c, 30)[n - 1]],
        rsi: [ctx.rsi(14), ctx.ta.rsi(c, 14)[n - 1]],
        atr: [ctx.atr(14), ctx.ta.atr(s.high, s.low, c, 14)[n - 1]],
        emaBack: [ctx.ema(30, { back: 2 }), ctx.ta.ema(c, 30)[n - 3]],
      };
      for (const [k, [a, b]] of Object.entries(checks)) if (!near(a, b)) ctx.log('mismatch', k, a, b);
      const d = ctx.donchian(20);
      if (d) {
        const hi = Math.max(...s.high.slice(n - 21, n - 1)), lo = Math.min(...s.low.slice(n - 21, n - 1));
        if (!near(d.upper, hi) || !near(d.lower, lo)) ctx.log('donchian', d, hi, lo);
      }
      const x = ctx.adx(14);
      if (x && !(x.adx >= 0 && x.adx <= 100 && x.plusDI >= 0 && x.minusDI >= 0)) ctx.log('adx', x);
      const m = ctx.macd();
      if (m && !near(m.hist, m.macd - m.signal)) ctx.log('macd', m);
      const b = ctx.bollinger(20);
      if (b && !(b.upper >= b.mid && b.mid >= b.lower)) ctx.log('bollinger', b);
      const st = ctx.supertrend(10, { mult: 3 });
      if (st && !['up', 'down'].includes(st.direction)) ctx.log('supertrend', st);
      if (ctx.index > 200 && (!x || !m || !st)) ctx.log('still null', ctx.index);
    }`;
  const res = await run(user, code, { timeframe: '1h', warmupBars: 0, to: '2024-02-20' });
  assert.equal(res.status, 'done', JSON.stringify(res.error));
  assert.equal(res.logs, undefined, JSON.stringify(res.logs && res.logs.slice(0, 5)));
});

test('pyramiding: several positions at once, each settled on its own; maxPositions enforced', async () => {
  const user = H.newUserId();
  const code = `
    function onBar(ctx) {
      if (ctx.time.utc.minute !== 0) return;
      const c = ctx.bar.close;
      if (ctx.positions.length < 3) ctx.buy({ stop: c - 3, target: c + 3, tag: 'unit' + (ctx.positions.length + 1) });
      if (ctx.time.utc.hour === 12) ctx.buy({ stop: c - 3 }); // a 4th is rejected while 3 are open
    }`;
  const res = await run(user, code, { maxPositions: 3, to: '2024-01-25' });
  assert.equal(res.status, 'done', JSON.stringify(res.error));
  const trades = await all(user, res);
  const overlaps = trades.filter((t, i) => trades.some((u, j) => j !== i && u.entryTime < t.exitTime && t.entryTime < u.exitTime)).length;
  assert.ok(overlaps > 10, `positions overlap (${overlaps})`);
  assert.ok(res.rejectedActions.first.some(r => /maxPositions/.test(r)));
  for (const t of trades.filter(t => t.exitReason !== 'end')) {
    const truth = H.firstLevelOn1m({ direction: 'long', stopLoss: t.stopLoss, takeProfit: t.takeProfit }, toSec(t.entryTime) + 900, Infinity);
    assert.equal(t.exitReason, truth, t.entryTime);
  }
  const ids = new Set(trades.map(t => t.entryTime + t.tag));
  assert.equal(ids.size, trades.length);
});

test('partial exits: R adds up each part at its own price; trailing stops move', async () => {
  const user = H.newUserId();
  const code = `
    function onBar(ctx) {
      const c = ctx.bar.close;
      if (!ctx.position && ctx.time.utc.hour === 10 && ctx.time.utc.minute === 0) { ctx.buy({ stop: c - 50 }); return; }
      const p = ctx.position;
      if (!p) return;
      if (p.barsHeld === 2) ctx.close({ fraction: 0.5 });
      else if (p.barsHeld === 4) ctx.modify({ stop: c - 40 });
      else if (p.barsHeld === 6) ctx.close();
    }`;
  const res = await run(user, code, { to: '2024-01-20' });
  const trades = await all(user, res);
  assert.ok(trades.length > 3);
  for (const t of trades) {
    assert.equal(t.partials.length, 1);
    assert.equal(t.partials[0].portion, 0.5);
    const risk = t.entryPrice - t.stopLoss;
    const expected = 0.5 * (t.partials[0].price - t.entryPrice) / risk + 0.5 * (t.exitPrice - t.entryPrice) / risk;
    assert.ok(Math.abs(t.rMultiple - expected) < 2e-3, `${t.rMultiple} vs ${expected}`);
    assert.ok(t.finalStopLoss > t.stopLoss, 'stop was trailed up');
    assert.equal(t.exitReason, 'manual');
  }
});

test('several symbols in one run, combined and broken down by symbol', async () => {
  const user = H.newUserId();
  const code = `function onBar(ctx) { if (!ctx.position && ctx.time.utc.hour === 14 && ctx.time.utc.minute === 0) ctx.buy({ stop: ctx.bar.close - 1, target: ctx.bar.close + 1, tag: ctx.symbol }); }`;
  const res = await run(user, code, { symbol: undefined, symbols: ['XAUUSD', 'XAUEUR'], to: '2024-01-25' });
  assert.equal(res.status, 'done', JSON.stringify(res.error));
  const r = await runner.getRun(user, res.runId, { groupBy: ['symbol'] });
  assert.deepEqual(r.breakdowns.symbol.map(g => g.symbol).sort(), ['XAUEUR', 'XAUUSD']);
  assert.equal(r.breakdowns.symbol[0].trades, r.breakdowns.symbol[1].trades, 'same feed, same trades');
  assert.equal(r.summary.trades, r.breakdowns.symbol[0].trades * 2);
  assert.ok((await all(user, res)).every(t => t.tag === undefined || t.tag === 'XAUUSD' || t.tag === 'XAUEUR'));
});

test('the reference examples run', async () => {
  const { REFERENCE } = require('../lib/strategySandbox/reference');
  const blocks = REFERENCE.split('## Example').slice(1).map(b => b.slice(b.indexOf('\n') + 1));
  const settings = [
    { timeframe: '15min' },
    { timeframe: '1h', maxPositions: 3, params: { entry: 20, add: 0.5, trail: 3 } },
    { timeframe: '5min', to: '2024-01-25' },
  ];
  assert.equal(blocks.length, settings.length);
  for (const [i, code] of blocks.entries()) {
    const res = await run(H.newUserId(), code, settings[i]);
    assert.equal(res.status, 'done', `example ${i}: ${JSON.stringify(res.error)}`);
    assert.ok(res.summary.trades > 0, `example ${i} traded`);
  }
});
