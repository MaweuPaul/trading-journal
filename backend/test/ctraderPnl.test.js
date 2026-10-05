const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../fixtures/agentReplayHarness');
const { convertCTraderPnlToGross } = require('../lib/ctraderPnl');
const { netTradeAmount } = require('../lib/tradeMath');

test('old cTrader trades are converted once; MT5 and new trades are left alone', async () => {
  const user = H.newUserId();
  const base = { user, symbol: 'XAUUSD', direction: 'BUY', entryPrice: 1, exitPrice: 2, lotSize: 1, openTime: new Date(), closeTime: new Date() };
  const old = await H.models.JournalTrade.create({ ...base, dealId: 'c1', accountKey: 'ctrader:1', pnlUSD: 90, commission: -8, swap: -2, runningBalance: 1090 });
  const fresh = await H.models.JournalTrade.create({ ...base, dealId: 'c2', accountKey: 'ctrader:1', pnlUSD: 100, commission: -8, swap: -2, runningBalance: 1180, grossPnl: true });
  const mt5 = await H.models.JournalTrade.create({ ...base, dealId: 'm1', accountKey: 'mt5:1', pnlUSD: 100, commission: -8, swap: -2, runningBalance: 1090 });
  assert.equal(await convertCTraderPnlToGross(), 1);
  assert.equal(await convertCTraderPnlToGross(), 0, 'a second run changes nothing');
  const get = async t => H.models.JournalTrade.findOne({ _id: t._id }).lean();
  const o = await get(old);
  assert.equal(o.pnlUSD, 100);
  assert.equal(o.pnlPct, 10);
  assert.equal(netTradeAmount(o), 90, 'net now equals the balance change');
  assert.equal((await get(fresh)).pnlUSD, 100);
  assert.equal((await get(mt5)).pnlUSD, 100);
});
