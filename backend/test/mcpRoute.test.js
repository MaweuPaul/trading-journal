const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';
const H = require('../fixtures/agentReplayHarness');
const express = require('express');

const app = express();
app.use(express.json());
for (const name of ['apiKeys', 'mcp', 'backtestTrades']) app.use('/api', require(`../routes/${name}`));

const userId = H.newUserId();
const ownerToken = jwt.sign({ userId, role: 'owner' }, process.env.JWT_SECRET);
let server, base;
test.before(() => new Promise(resolve => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api`; resolve(); }); }));
test.after(() => server.close());

const owner = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}`, ...init.headers } });
async function createKey(name = 'test') {
  const res = await owner('/api-keys', { method: 'POST', body: JSON.stringify({ name }) });
  return { res, body: await res.json() };
}
function mcpClient(key) {
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    return { status: res.status, body: await res.json() };
  };
  const call = async (name, args = {}) => {
    const { body } = await rpc('tools/call', { name, arguments: args });
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    return { isError: Boolean(body.result.isError), data: JSON.parse(body.result.content[0].text) };
  };
  return { rpc, call };
}

test('access keys: plaintext shown once, hash never returned', async () => {
  const { res, body } = await createKey('laptop');
  assert.equal(res.status, 201);
  assert.match(body.key, /^tjk_[A-Za-z0-9_-]{43}$/);
  assert.equal(body.keyHash, undefined);
  const list = await (await owner('/api-keys')).json();
  const listed = list.keys.find(k => k._id === body._id);
  assert.equal(listed.key, undefined);
  assert.equal(listed.keyHash, undefined);
  assert.equal(listed.prefix, body.key.slice(0, 10));
  assert.equal((await owner('/api-keys', { method: 'POST', body: '{}' })).status, 400);
});

test('keys only work on /api/mcp, and JWTs never do', async () => {
  const { body: { key } } = await createKey();
  for (const path of ['/backtest-trades', '/api-keys']) {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(res.status, 401, path);
  }
  const withJwt = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(withJwt.status, 401);
  const inUrl = await fetch(`${base}/mcp?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(inUrl.status, 401);
  const unknown = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer tjk_notarealkey', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unknown.status, 401);
});

test('MCP: a full backtest loop over HTTP', async () => {
  const { body: { key } } = await createKey();
  const { rpc, call } = mcpClient(key);

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'tradejournal-backtest');
  const tools = (await rpc('tools/list', {})).body.result.tools.map(t => t.name).sort();
  assert.deepEqual(tools, ['close_trade', 'create_strategy', 'discard_trade', 'end_session', 'get_candles', 'get_metrics', 'get_state',
    'list_sessions', 'list_strategies', 'list_symbols', 'log_trade', 'open_trade', 'set_timeframe', 'start_session', 'step']);

  assert.ok((await call('list_symbols', { search: 'usd' })).data.symbols.includes('XAUUSD'));
  assert.equal((await call('create_strategy', { name: 'Breakout', description: 'Buy the break of the Asian range' })).data.name, 'Breakout');

  const started = await call('start_session', { symbol: 'XAUUSD', interval: '15min', from: '2024-01-08T00:00Z', to: '2024-01-31T00:00Z', strategy: 'Breakout', context: 20 });
  assert.equal(started.isError, false);
  assert.equal(started.data.candles.length, 20);
  const sessionId = started.data.sessionId;

  const candles = await call('get_candles', { sessionId, timeframe: '4h', count: 5 });
  assert.ok(candles.data.candles.length >= 5);
  const stepped = await call('step', { sessionId, bars: 8 });
  assert.equal(stepped.data.revealed, 8);

  const entry = stepped.data.state.lastCandle.close;
  const opened = await call('open_trade', { sessionId, direction: 'long', stopLoss: entry - 3, takeProfit: entry + 6 });
  assert.equal(opened.data.opened.entryPrice, entry);
  const twice = await call('open_trade', { sessionId, direction: 'long', stopLoss: entry - 3 });
  assert.equal(twice.isError, true);
  assert.match(twice.data.error, /already open/);

  const run = await call('step', { sessionId, bars: 2000 });
  assert.ok(run.data.events.some(e => e.type === 'trade_closed'));
  const logged = await call('log_trade', { sessionId, notes: 'Broke the Asian high', setupQuality: 4 });
  const trade = H.models.Trade.store.get(logged.data.tradeId);
  assert.equal(trade.source, 'agent');
  assert.equal(String(trade.user), userId);

  assert.equal((await call('get_metrics')).data.overall.trades, 1);
  assert.ok((await call('list_sessions')).data.sessions.some(s => s.sessionId === sessionId));
  assert.equal((await call('end_session', { sessionId })).data.ended, true);
  const afterEnd = await call('step', { sessionId });
  assert.equal(afterEnd.isError, true);
  assert.match(afterEnd.data.error, /ended/);

  const badSymbol = await call('start_session', { symbol: 'NOPE', from: '2024-01-08', to: '2024-01-09' });
  assert.equal(badSymbol.isError, true);
});

test('GET and DELETE on /mcp are not allowed (stateless server)', async () => {
  const { body: { key } } = await createKey();
  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(`${base}/mcp`, { method, headers: { Authorization: `Bearer ${key}` } });
    assert.equal(res.status, 405, method);
  }
});

test('a revoked key stops working immediately', async () => {
  const { body } = await createKey('to revoke');
  const { rpc } = mcpClient(body.key);
  assert.equal((await rpc('tools/list', {})).status, 200);
  assert.equal((await owner(`/api-keys/${body._id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await rpc('tools/list', {})).status, 401);
  assert.equal((await owner(`/api-keys/${body._id}`, { method: 'DELETE' })).status, 404);
});
