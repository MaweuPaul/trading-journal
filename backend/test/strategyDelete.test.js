const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';
const H = require('../fixtures/agentReplayHarness');
const express = require('express');

const app = express();
app.use(express.json());
app.use('/api', require('../routes/backtestStrategies'));
const userId = H.newUserId();
const token = jwt.sign({ userId, role: 'owner' }, process.env.JWT_SECRET);
let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api`; r(); }); }));
test.after(() => server.close());
const del = (name, untag = true) => fetch(`${base}/backtest-strategies/by-name/${encodeURIComponent(name)}${untag ? '?untag=1' : ''}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });

const trade = extra => H.models.Trade.create({ user: userId, symbol: 'XAUUSD', interval: '15min', direction: 'long', entryTime: 1, entryPrice: 1, exitTime: 2, exitPrice: 1, stopLoss: 0.5, outcome: 'win', rMultiple: 1, ...extra });

test('deleting a tag-only strategy removes the tag and keeps the backtests', async () => {
  const a = await trade({ strategy: 'ORB', tags: ['ORB', '5m range'] });
  const b = await trade({ strategy: '5m range', tags: ['5m range', 'ORB'] });
  const c = await trade({ strategy: 'ORB', tags: ['ORB'] });
  const legacy = await trade({ strategy: 'ORB', tags: [] });
  const other = await trade({ strategy: 'Other', tags: ['Other'] });

  const res = await del('ORB');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, deletedDefinition: false, untagged: 4 });
  const get = t => H.models.Trade.store.get(String(t._id));
  assert.deepEqual([get(a).strategy, get(a).tags], ['5m range', ['5m range']], 'next tag becomes the primary strategy');
  assert.deepEqual([get(b).strategy, get(b).tags], ['5m range', ['5m range']]);
  assert.deepEqual([get(c).strategy, get(c).tags], ['', []]);
  assert.deepEqual([get(legacy).strategy, get(legacy).tags], ['', []]);
  assert.deepEqual(get(other).tags, ['Other'], 'other strategies untouched');
  assert.equal(H.models.Trade.store.size, 5, 'no backtest deleted');
});

test('?all=1 deletes the strategy with its backtests, code runs and replay sessions', async () => {
  const owner = H.newUserId();
  const ownToken = jwt.sign({ userId: owner, role: 'owner' }, process.env.JWT_SECRET);
  const mk = extra => H.models.Trade.create({ user: owner, symbol: 'XAUUSD', interval: '15min', direction: 'long', entryTime: 1, entryPrice: 1, exitTime: 2, exitPrice: 1, stopLoss: 0.5, outcome: 'win', rMultiple: 1, ...extra });
  await H.models.Strategy.create({ user: owner, name: 'FVG', description: 'x' });
  const mine = await mk({ strategy: 'FVG', tags: ['FVG', 'London'] });
  const agent = await mk({ strategy: 'FVG', tags: ['FVG'], source: 'agent' });
  const shared = await mk({ strategy: 'ORB', tags: ['ORB', 'FVG'] });
  const other = await mk({ strategy: 'ORB', tags: ['ORB'] });
  const strangers = await trade({ strategy: 'FVG', tags: ['FVG'] }); // another user's
  const run = await H.models.StrategyRun.create({ user: owner, code: 'x', settings: { logAs: 'FVG' } });
  const otherRun = await H.models.StrategyRun.create({ user: owner, code: 'x', settings: { logAs: 'ORB' } });
  const session = await H.models.Session.create({ user: owner, symbol: 'XAUUSD', strategy: 'FVG', interval: '15min', fromMs: 0, toMs: 1, clock: 0, expiresAt: new Date(Date.now() + 86400000) });

  const res = await fetch(`${base}/backtest-strategies/by-name/FVG?all=1`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownToken}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deletedDefinition, true);
  assert.equal(body.deletedBacktests, 2);
  assert.equal(body.untagged, 1);
  assert.equal(body.deletedRuns, 1);
  const get = t => H.models.Trade.store.get(String(t._id));
  assert.equal(get(mine), undefined);
  assert.equal(get(agent), undefined);
  assert.deepEqual([get(shared).strategy, get(shared).tags], ['ORB', ['ORB']], 'other strategy kept, tag removed');
  assert.ok(get(other));
  assert.ok(get(strangers), 'other users untouched');
  assert.equal(H.models.StrategyRun.store.has(String(run._id)), false);
  assert.ok(H.models.StrategyRun.store.has(String(otherRun._id)));
  assert.equal(body.deletedSessions, 1);
  assert.equal(H.models.Session.store.has(String(session._id)), false);
  const again = await fetch(`${base}/backtest-strategies/by-name/FVG?all=1`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownToken}` } });
  assert.equal(again.status, 404);
});

test('deleting a saved strategy removes its definition too; unknown names are 404', async () => {
  await H.models.Strategy.create({ user: userId, name: 'Saved', description: 'x' });
  const t = await trade({ strategy: 'Saved', tags: ['Saved'] });
  const res = await del('Saved');
  assert.deepEqual(await res.json(), { ok: true, deletedDefinition: true, untagged: 1 });
  assert.deepEqual(H.models.Trade.store.get(String(t._id)).tags, []);
  assert.equal([...H.models.Strategy.store.values()].some(s => s.name === 'Saved'), false);
  assert.equal((await del('Nothing here')).status, 404);
});
