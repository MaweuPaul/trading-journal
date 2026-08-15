const test = require('node:test');
const assert = require('node:assert/strict');
const {
  netTradeAmount,
  summarizeTradeResults,
  calculateDrawdown,
  realizedRMultiple,
  calculateMissedProfit,
} = require('../lib/tradeMath');

test('netTradeAmount includes commission and swap, not just pnlUSD', () => {
  assert.equal(netTradeAmount({ pnlUSD: 100, commission: -5, swap: -1 }), 94);
  assert.equal(netTradeAmount({ pnlUSD: -20, commission: -2, swap: 0.5 }), -21.5);
  assert.equal(netTradeAmount({ pnlUSD: 10 }), 10);
});

test('summarizeTradeResults matches a hand-computed 4-trade fixture', () => {
  // Two wins (+100, +50), two losses (-40, -20), each with $1 commission.
  // netPnL = 99 + 49 - 41 - 21 = 86
  const trades = [
    { pnlUSD: 100, commission: -1, swap: 0 },
    { pnlUSD: 50, commission: -1, swap: 0 },
    { pnlUSD: -40, commission: -1, swap: 0 },
    { pnlUSD: -20, commission: -1, swap: 0 },
  ];
  const r = summarizeTradeResults(trades);
  assert.equal(r.wins.length, 2);
  assert.equal(r.losses.length, 2);
  assert.equal(r.grossProfit, 148); // 99 + 49
  assert.equal(r.grossLoss, 62); // 41 + 21
  assert.equal(r.netPnL, 86);
  assert.equal(r.grossPnL, 90); // raw pnlUSD sum, no costs: 100+50-40-20
  assert.equal(r.winRate, 50);
  assert.equal(r.profitFactor, 148 / 62);
  assert.equal(r.avgWinUSD, 74); // 148 / 2
  assert.equal(r.avgLossUSD, 31); // 62 / 2
  assert.equal(r.biggestWin, 99);
  assert.equal(r.biggestLoss, -41);
});

test('summarizeTradeResults returns the 999 sentinel instead of Infinity when there are no losses', () => {
  const r = summarizeTradeResults([{ pnlUSD: 50, commission: 0, swap: 0 }]);
  assert.equal(r.profitFactor, 999);
  assert.equal(r.winLossRatio, 999);
});

test('summarizeTradeResults returns zeros (not NaN) for an empty trade list', () => {
  const r = summarizeTradeResults([]);
  assert.equal(r.winRate, 0);
  assert.equal(r.profitFactor, 0);
  assert.equal(r.expectancyUSD, 0);
  assert.equal(Number.isNaN(r.winRate), false);
});

test('calculateDrawdown computes peak-to-trough on runningBalance', () => {
  // Balance path: 1000 -> 1200 (peak) -> 900 (25% DD from peak) -> 1100 (recovering, still down from peak)
  const trades = [
    { closeTime: '2026-01-01', runningBalance: 1200, pnlUSD: 200, commission: 0, swap: 0 },
    { closeTime: '2026-01-02', runningBalance: 900, pnlUSD: -300, commission: 0, swap: 0 },
    { closeTime: '2026-01-03', runningBalance: 1100, pnlUSD: 200, commission: 0, swap: 0 },
  ];
  const d = calculateDrawdown(trades);
  assert.equal(d.maxDrawdownPct, 25); // (1200-900)/1200 * 100
  assert.equal(d.currentDrawdown, (1200 - 1100) / 1200 * 100);
  assert.equal(d.equityCurve.length, 3);
});

test('realizedRMultiple divides pnlUSD by riskUSD, and is null without real risk data', () => {
  assert.equal(realizedRMultiple({ pnlUSD: 150, riskUSD: 50 }), 3); // won at 3R
  assert.equal(realizedRMultiple({ pnlUSD: -50, riskUSD: 50 }), -1); // full stop loss
  assert.equal(realizedRMultiple({ pnlUSD: 150, riskUSD: 0 }), null);
  assert.equal(realizedRMultiple({ pnlUSD: 150 }), null);
});

test('calculateMissedProfit is NOT the BUG-2 formula: it must not always equal zero', () => {
  // Planned 5R, actual risk was $50 (from MT5 stop), trade closed at +$150 (3R)
  // via a "Fear" early exit -> missed 2R = $100.
  const trades = [
    { _id: 't1', symbol: 'EURUSD', direction: 'BUY', closeTime: '2026-01-01', pnlUSD: 150, plannedRR: 5, riskUSD: 50, exitReason: 'Fear' },
  ];
  const result = calculateMissedProfit(trades);
  assert.equal(result.count, 1);
  assert.equal(result.withRiskData, 1);
  assert.equal(result.totalMissedRR, 2); // 5R planned - 3R actual
  assert.equal(result.estimatedMissedUSD, 100); // 2R * $50/R
  assert.notEqual(result.estimatedMissedUSD, 0, 'BUG-2 regression: missed profit collapsed to zero');
});

test('calculateMissedProfit reports null (not zero) for trades with no recorded risk', () => {
  const trades = [
    { _id: 't2', symbol: 'GBPUSD', direction: 'SELL', closeTime: '2026-01-02', pnlUSD: 80, plannedRR: 4, exitReason: 'ManualClose' },
  ];
  const result = calculateMissedProfit(trades);
  assert.equal(result.count, 1);
  assert.equal(result.withRiskData, 0);
  assert.equal(result.trades[0].hasRiskData, false);
  assert.equal(result.trades[0].missedRR, null);
  assert.equal(result.trades[0].estimatedMissedUSD, null);
  // Totals stay at zero because nothing contributed real data — that's
  // different from claiming "zero missed profit" as a computed fact.
  assert.equal(result.estimatedMissedUSD, 0);
});

test('calculateMissedProfit excludes clean TP/SL exits and trades without a plan', () => {
  const trades = [
    { _id: 't3', pnlUSD: 100, plannedRR: 2, riskUSD: 50, exitReason: 'TP' },
    { _id: 't4', pnlUSD: -50, plannedRR: 2, riskUSD: 50, exitReason: 'SL' },
    { _id: 't5', pnlUSD: 30, riskUSD: 50, exitReason: 'Fear' }, // no plannedRR
    { _id: 't6', pnlUSD: 30, plannedRR: 2, riskUSD: 50, exitReason: '' },
  ];
  const result = calculateMissedProfit(trades);
  assert.equal(result.count, 0);
});
