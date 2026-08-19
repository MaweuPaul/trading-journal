const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';
const auth = require('../middleware/auth');

function authorize(method, originalUrl, role = 'sync_agent') {
  const payload = { userId: '507f1f77bcf86cd799439011', role };
  if (role === 'investor') payload.tradingAccountId = '507f1f77bcf86cd799439012';
  const token = jwt.sign(payload, process.env.JWT_SECRET);
  const req = { method, originalUrl, header: name => name === 'Authorization' ? `Bearer ${token}` : '' };
  let response;
  let nextCalled = false;
  const res = { status(code) { response = { code }; return this; }, json(body) { response.body = body; return this; } };
  auth(req, res, () => { nextCalled = true; });
  return { response, nextCalled };
}

test('sync-agent JWT is limited to worker endpoints', () => {
  assert.equal(authorize('POST', '/api/sync').nextCalled, true);
  assert.equal(authorize('GET', '/api/sync-agent/trading-accounts?x=1').nextCalled, true);
  assert.equal(authorize('GET', '/api/trades').response.code, 403);
  assert.equal(authorize('DELETE', '/api/maintenance/trades').response.code, 403);
  // Replay now runs entirely through cTrader on the API side — the MT5 sync
  // agent no longer has any replay-related endpoints to reach.
  assert.equal(authorize('GET', '/api/replay-requests').response.code, 403);
  assert.equal(authorize('POST', '/api/trades/abc/replay-candles').response.code, 403);
});

test('investor JWT is limited to the three read-only investor endpoints', () => {
  assert.equal(authorize('GET', '/api/investor/summary', 'investor').nextCalled, true);
  assert.equal(authorize('GET', '/api/investor/trades?page=2', 'investor').nextCalled, true);
  assert.equal(authorize('GET', '/api/investor/trades/abc123/replay?interval=15min', 'investor').nextCalled, true);
  assert.equal(authorize('GET', '/api/trades', 'investor').response.code, 403);
  assert.equal(authorize('DELETE', '/api/trading-accounts/abc', 'investor').response.code, 403);
  assert.equal(authorize('GET', '/api/stats', 'investor').response.code, 403);
  assert.equal(authorize('POST', '/api/investor/login', 'investor').response.code, 403);
  assert.equal(authorize('GET', '/api/trades/abc123/replay', 'investor').response.code, 403);
});
