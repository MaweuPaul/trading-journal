const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';
const tradesRouter = require('../routes/trades');
const H = require('../fixtures/agentReplayHarness');
const express = require('express');

const app = express();
app.use(express.json());
app.use('/api', tradesRouter);
const user = H.newUserId();
const token = jwt.sign({ userId: user, role: 'owner' }, process.env.JWT_SECRET);
let server, base, tradeId;
test.before(async () => {
  const t = await H.models.JournalTrade.create({
    user, accountKey: 'ctrader:1', dealId: 's1', positionId: 's1', symbol: 'XAUUSD', direction: 'BUY',
    entryPrice: 2000, exitPrice: 2010, lotSize: 1, pnlUSD: 993, commission: -7, swap: 0, runningBalance: 10993,
    openTime: new Date('2026-10-01T10:00:00Z'), closeTime: new Date('2026-10-01T11:00:00Z'), stopLoss: null, riskUSD: null,
  });
  tradeId = String(t._id);
  await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api`; r(); }); });
});
test.after(() => server.close());
const put = body => fetch(`${base}/trades/${tradeId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));

test('a stop typed in by hand sets the risk the R-multiple is measured against', async () => {
  const { status, body } = await put({ stopLoss: 1995, takeProfit: '2020' });
  assert.equal(status, 200);
  assert.equal(body.stopLoss, 1995);
  assert.equal(body.takeProfit, 2020);
  assert.equal(body.riskUSD, 500);
  assert.equal(body.riskPercent, 5);
});

test('a stop on the wrong side of the entry is refused', async () => {
  const { status, body } = await put({ stopLoss: 2005 });
  assert.equal(status, 400);
  assert.match(body.error, /below its entry price/);
  assert.equal((await put({ stopLoss: 'abc' })).status, 400);
});

test('saving notes leaves the stop alone; clearing the stop clears the risk', async () => {
  assert.equal((await put({ notes: 'held to target' })).body.riskUSD, 500);
  const { body } = await put({ stopLoss: '' });
  assert.equal(body.stopLoss, null);
  assert.equal(body.riskUSD, null);
});
