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
