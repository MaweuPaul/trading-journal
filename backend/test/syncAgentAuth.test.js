const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';
const auth = require('../middleware/auth');

function authorize(method, originalUrl) {
  const token = jwt.sign({ userId: '507f1f77bcf86cd799439011', role: 'sync_agent' }, process.env.JWT_SECRET);
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
  assert.equal(authorize('POST', '/api/trades/abc/replay-candles').nextCalled, true);
  assert.equal(authorize('GET', '/api/trades').response.code, 403);
  assert.equal(authorize('DELETE', '/api/maintenance/trades').response.code, 403);
});
