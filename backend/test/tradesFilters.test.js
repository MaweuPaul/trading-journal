const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';
// Load the routes (and every model they use) before the harness swaps the
// models it knows for in-memory ones.
const tradesRouter = require('../routes/trades');
const H = require('../fixtures/agentReplayHarness');
const express = require('express');

const app = express();
app.use(express.json());
app.use('/api', tradesRouter);
const user = H.newUserId();
const token = jwt.sign({ userId: user, role: 'owner' }, process.env.JWT_SECRET);
let server, base;
test.before(async () => {
  const t = (symbol, closeTime, dealId) => H.models.JournalTrade.create({ user, accountKey: 'ctrader:1', dealId, positionId: dealId, symbol, direction: 'BUY', entryPrice: 1, exitPrice: 2, lotSize: 1, pnlUSD: 1, openTime: new Date(closeTime), closeTime: new Date(closeTime) });
  await t('Nasdaq100', '2026-10-02T13:41:00Z', 'd1');
  await t('Nasdaq100', '2026-10-01T14:59:00Z', 'd2');
  await t('XAUUSD', '2026-09-24T14:33:00Z', 'd3');
  await t('S&P500', '2026-09-22T17:02:00Z', 'd4');
  await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api`; r(); }); });
});
test.after(() => server.close());
const get = q => fetch(`${base}/trades?${new URLSearchParams(q)}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).then(d => (d.trades || []).map(t => t.dealId).sort());

test('symbol filter matches mixed-case broker names and symbols with special characters', async () => {
  assert.deepEqual(await get({ symbol: 'Nasdaq100' }), ['d1', 'd2']);
  assert.deepEqual(await get({ symbol: 'NASDAQ100' }), ['d1', 'd2']);
  assert.deepEqual(await get({ symbol: 'S&P500' }), ['d4']);
});

test('a date-only To includes that whole day', async () => {
  assert.deepEqual(await get({ from: '2026-10-01', to: '2026-10-01' }), ['d2']);
  assert.deepEqual(await get({ from: '2026-09-24', to: '2026-10-02' }), ['d1', 'd2', 'd3']);
});

test('exact times from the Trades page (the visitor\'s own day) are used as given', async () => {
  // 2 Oct in UTC+3: 1 Oct 21:00Z to 2 Oct 20:59:59.999Z
  assert.deepEqual(await get({ from: '2026-10-01T21:00:00.000Z', to: '2026-10-02T20:59:59.999Z' }), ['d1']);
});
