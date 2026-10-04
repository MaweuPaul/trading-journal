const test = require('node:test');
const assert = require('node:assert/strict');
const { riskFromStop, isLossSideStop, moneyPerPricePerLotBySymbol, grossPriceProfit } = require('../lib/tradeRisk');
const { initialStopsByPosition, stopUpdates, fetchAllOrders } = require('../lib/ctraderSync');
const { realizedRMultiple } = require('../lib/tradeMath');

// XAUUSD buy, 1 lot = 100 oz: 2000 -> 2010 made $1,000 gross; cTrader's pnlUSD is net of $7 commission.
const gold = { accountKey: 'ctrader:1', symbol: 'XAUUSD', direction: 'BUY', entryPrice: 2000, exitPrice: 2010, lotSize: 1, pnlUSD: 993, commission: -7, swap: 0, runningBalance: 10993, positionId: '77', dealId: 'd1' };

test('risk comes from the stop distance priced by the trade\'s own move', () => {
  assert.equal(grossPriceProfit(gold), 1000);
  const { riskUSD, riskPercent } = riskFromStop(gold, 1995);
  assert.equal(riskUSD, 500);                 // 5.00 of price * $100 per 1.00
  assert.equal(riskPercent, 5);               // of the $10,000 before the trade
  assert.equal(realizedRMultiple({ ...gold, riskUSD }), 993 / 500);
});

test('MT5 P&L is already gross, and a sell\'s stop sits above the entry', () => {
  const sell = { accountKey: 'mt5:1', symbol: 'EURUSD', direction: 'SELL', entryPrice: 1.1, exitPrice: 1.098, lotSize: 1, pnlUSD: 200, commission: -7, swap: 0, runningBalance: 10193 };
  assert.equal(riskFromStop(sell, 1.101).riskUSD, 100);
  assert.equal(isLossSideStop('SELL', 1.1, 1.099), false);
  assert.deepEqual(riskFromStop(sell, 1.099), { riskUSD: null, riskPercent: null }, 'a stop in profit is not risk');
});

test('a trade that closed flat is priced from the same symbol\'s other trades', () => {
  const flat = { ...gold, exitPrice: 2000, pnlUSD: -7, lotSize: 0.5 };
  assert.deepEqual(riskFromStop(flat, 1990), { riskUSD: null, riskPercent: null });
  const perLot = moneyPerPricePerLotBySymbol([gold, flat]);
  assert.equal(riskFromStop(flat, 1990, { perLotBySymbol: perLot }).riskUSD, 500); // 10 * $100 * 0.5 lot
});

test('the stop on the opening order wins; a later stop moved to break-even is ignored', () => {
  const entries = new Map([['77', { direction: 'BUY', entryPrice: 2000 }], ['78', { direction: 'SELL', entryPrice: 1.1 }], ['79', { direction: 'BUY', entryPrice: 50 }]]);
  const orders = [
    // 77: market order with an absolute stop, then the stop dragged to entry.
    { orderId: 1, positionId: 77, orderType: 1, closingOrder: false, stopLoss: 1995, takeProfit: 2020, tradeData: { openTimestamp: 1000 } },
    { orderId: 2, positionId: 77, orderType: 4, stopLoss: 2000, tradeData: { openTimestamp: 2000 } },
    // 78: the opening order had a relative stop (in 1/100000 of price).
    { orderId: 3, positionId: 78, orderType: 1, closingOrder: false, relativeStopLoss: 200, relativeTakeProfit: 400, tradeData: { openTimestamp: 1000 } },
    // 79: no stop on the open; one added afterwards as a stop-loss order.
    { orderId: 4, positionId: 79, orderType: 1, closingOrder: false, stopLoss: 0, tradeData: { openTimestamp: 1000 } },
    { orderId: 5, positionId: 79, orderType: 4, stopPrice: 48, tradeData: { openTimestamp: 3000 } },
    // A position the journal doesn't hold is left out.
    { orderId: 6, positionId: 99, orderType: 1, stopLoss: 1, tradeData: { openTimestamp: 1000 } },
  ];
  const stops = initialStopsByPosition(orders, entries);
  assert.deepEqual(stops.get('77'), { stopLoss: 1995, takeProfit: 2020 });
  assert.ok(Math.abs(stops.get('78').stopLoss - 1.102) < 1e-9);
  assert.ok(Math.abs(stops.get('78').takeProfit - 1.096) < 1e-9);
  assert.deepEqual(stops.get('79'), { stopLoss: 48, takeProfit: null });
  assert.equal(stops.has('99'), false);
});

test('updates carry the stop, target and the risk they imply', () => {
  const [u] = stopUpdates([{ ...gold, _id: 'x' }], new Map([['77', { stopLoss: 1995, takeProfit: 2020 }]]));
  assert.deepEqual(u, { _id: 'x', dealId: 'd1', set: { stopLoss: 1995, takeProfit: 2020, riskUSD: 500, riskPercent: 5 } });
});

test('order history is split into smaller windows while cTrader says there is more', async () => {
  const DAY = 864e5;
  const calls = [];
  const client = {
    request: async (_type, { fromTimestamp, toTimestamp }) => {
      calls.push([fromTimestamp, toTimestamp]);
      const wide = toTimestamp - fromTimestamp > 10 * DAY;
      return { hasMore: wide, order: wide ? [{ orderId: 'partial' }] : [{ orderId: `${fromTimestamp}` }] };
    },
  };
  const orders = await fetchAllOrders(client, 1, 0, 40 * DAY);
  assert.ok(orders.every(o => o.orderId !== 'partial'), 'a capped window\'s rows are replaced by its halves');
  assert.equal(orders.length, 4);
  assert.equal(calls.length, 7);
});
