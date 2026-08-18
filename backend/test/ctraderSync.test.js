const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTradesFromDeals, buildAccountEventsFromCashFlow } = require('../lib/ctraderSync');

const IDENTITY = { accountKey: 'ctrader:acc1', accountType: 'live', accountName: 'cTrader Live', tradingAccount: 'trading-account-id' };
const symbolNames = new Map([['1', 'EURUSD'], ['2', 'XAUUSD']]);

test('maps a simple open+close position to one trade with clean P&L math', () => {
  const deals = [
    { dealId: 1, positionId: 500, symbolId: 1, tradeSide: 1, executionTimestamp: 1700000000000, commission: 0, moneyDigits: 2 },
    {
      dealId: 2, positionId: 500, symbolId: 1, tradeSide: 2, executionTimestamp: 1700000600000, executionPrice: 1.205,
      closePositionDetail: { entryPrice: 1.2, grossProfit: 5000, swap: 0, commission: 0, balance: 1005000, closedVolume: 1000000, moneyDigits: 2 },
    },
  ];
  const [trade] = buildTradesFromDeals(deals, symbolNames, IDENTITY);
  assert.equal(trade.dealId, '2');
  assert.equal(trade.positionId, '500');
  assert.equal(trade.symbol, 'EURUSD');
  assert.equal(trade.direction, 'BUY'); // taken from the opening deal's side, not the closing one
  assert.equal(trade.entryPrice, 1.2);
  assert.equal(trade.exitPrice, 1.205);
  assert.equal(trade.lotSize, 0.1);
  assert.equal(trade.pnlUSD, 50);
  assert.equal(trade.runningBalance, 10050);
  assert.equal(trade.pnlPct, 0.5); // 50 / (10050 - 50) * 100
  assert.equal(trade.durationMinutes, 10);
  assert.deepEqual(IDENTITY, { accountKey: trade.accountKey, accountType: trade.accountType, accountName: trade.accountName, tradingAccount: trade.tradingAccount });
});

test('folds both the opening and closing deal commission into net P&L, and reads direction from a SELL open', () => {
  const deals = [
    { dealId: 3, positionId: 501, symbolId: 2, tradeSide: 2, executionTimestamp: 2000000000000, commission: -500, moneyDigits: 2 },
    {
      dealId: 4, positionId: 501, symbolId: 2, tradeSide: 1, executionTimestamp: 2000000300000, executionPrice: 1900,
      closePositionDetail: { entryPrice: 1910, grossProfit: 10000, swap: -200, commission: -300, balance: 20000, closedVolume: 500000, moneyDigits: 2 },
    },
  ];
  const [trade] = buildTradesFromDeals(deals, symbolNames, IDENTITY);
  assert.equal(trade.direction, 'SELL');
  assert.equal(trade.commission, -8); // -3.00 (close) + -5.00 (open)
  assert.equal(trade.swap, -2);
  assert.equal(trade.pnlUSD, 90); // 100 (gross) + -2 (swap) + -8 (commission)
});

test('emits one trade per closing deal on a partially closed position, sharing the same open time', () => {
  const openTimestamp = 1700000000000;
  const deals = [
    { dealId: 5, positionId: 502, symbolId: 1, tradeSide: 1, executionTimestamp: openTimestamp, commission: 0, moneyDigits: 2 },
    {
      dealId: 6, positionId: 502, symbolId: 1, tradeSide: 2, executionTimestamp: openTimestamp + 60000, executionPrice: 1.21,
      closePositionDetail: { entryPrice: 1.2, grossProfit: 2000, swap: 0, commission: 0, balance: 10020, closedVolume: 500000, moneyDigits: 2 },
    },
    {
      dealId: 7, positionId: 502, symbolId: 1, tradeSide: 2, executionTimestamp: openTimestamp + 120000, executionPrice: 1.22,
      closePositionDetail: { entryPrice: 1.2, grossProfit: 4000, swap: 0, commission: 0, balance: 10060, closedVolume: 500000, moneyDigits: 2 },
    },
  ];
  const trades = buildTradesFromDeals(deals, symbolNames, IDENTITY);
  assert.equal(trades.length, 2);
  assert.deepEqual(trades.map(t => t.dealId), ['6', '7']);
  assert.ok(trades.every(t => t.positionId === '502' && t.openTime === new Date(openTimestamp).toISOString()));
  assert.notEqual(trades[0].closeTime, trades[1].closeTime);
});

test('ignores deals with no closePositionDetail (opens/increases carry no realized P&L)', () => {
  const deals = [
    { dealId: 8, positionId: 503, symbolId: 1, tradeSide: 1, executionTimestamp: 1, commission: 0, moneyDigits: 2 },
    { dealId: 9, positionId: 503, symbolId: 1, tradeSide: 1, executionTimestamp: 2, commission: 0, moneyDigits: 2 }, // volume-increasing deal, still no close detail
  ];
  assert.deepEqual(buildTradesFromDeals(deals, symbolNames, IDENTITY), []);
});

test('falls back to a synthesized name for a symbolId missing from the resolved map', () => {
  const deals = [
    { dealId: 10, positionId: 504, symbolId: 999, tradeSide: 1, executionTimestamp: 1, commission: 0, moneyDigits: 2 },
    {
      dealId: 11, positionId: 504, symbolId: 999, tradeSide: 2, executionTimestamp: 2, executionPrice: 1,
      closePositionDetail: { entryPrice: 1, grossProfit: 0, swap: 0, commission: 0, balance: 0, closedVolume: 100000, moneyDigits: 2 },
    },
  ];
  const [trade] = buildTradesFromDeals(deals, symbolNames, IDENTITY);
  assert.equal(trade.symbol, 'Symbol999');
});

test('maps cash flow history into deposit/withdrawal account events', () => {
  const cashFlow = [
    { balanceHistoryId: 777, operationType: 0, delta: 100000, balance: 1105000, changeBalanceTimestamp: 1700000000000, moneyDigits: 2, externalNote: 'Bank transfer' },
    { balanceHistoryId: 778, operationType: 1, delta: -20000, balance: 1085000, changeBalanceTimestamp: 1700000100000, moneyDigits: 2 },
  ];
  const [deposit, withdrawal] = buildAccountEventsFromCashFlow(cashFlow, IDENTITY);
  assert.equal(deposit.type, 'deposit');
  assert.equal(deposit.externalId, 'ctrader-777');
  assert.equal(deposit.amount, 1000);
  assert.equal(deposit.balanceAfter, 11050);
  assert.equal(deposit.note, 'Bank transfer');
  assert.equal(withdrawal.type, 'withdrawal');
  assert.equal(withdrawal.amount, 200); // amount is always positive; type carries the direction
});
