const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleLevel, winRateRange, meanRange, confidenceFor } = require('../lib/confidence');

test('sample levels use one scale', () => {
  assert.equal(sampleLevel(0), 'insufficient');
  assert.equal(sampleLevel(9), 'insufficient');
  assert.equal(sampleLevel(10), 'early');
  assert.equal(sampleLevel(29), 'early');
  assert.equal(sampleLevel(30), 'developing');
  assert.equal(sampleLevel(99), 'developing');
  assert.equal(sampleLevel(100), 'reliable');
});

test('Wilson win-rate range matches reference values', () => {
  // Reference: Wilson 95% interval, e.g. from statsmodels proportion_confint(method="wilson").
  assert.deepEqual(winRateRange(3, 4), [30.1, 95.4]);
  assert.deepEqual(winRateRange(174, 300), [52.3, 63.4]);
  assert.deepEqual(winRateRange(0, 10), [0, 27.8]);
  assert.deepEqual(winRateRange(10, 10), [72.2, 100]);
  assert.equal(winRateRange(0, 0), null);
  // More trades, narrower range, around the same win rate.
  const [a, b] = winRateRange(6, 10), [c, d] = winRateRange(60, 100);
  assert.ok(d - c < b - a);
});

test('mean range is a Student-t interval', () => {
  // mean 1, sd 1 (sample), n 4 -> 1 +/- 3.182 * 1/2
  const [lo, hi] = meanRange([0, 0, 2, 2].map(v => v));
  const sd = Math.sqrt(4 / 3);
  assert.ok(Math.abs(lo - (1 - 3.182 * sd / 2)) < 1e-3);
  assert.ok(Math.abs(hi - (1 + 3.182 * sd / 2)) < 1e-3);
  assert.equal(meanRange([5]), null);
  const big = Array.from({ length: 200 }, (_, i) => (i % 2 ? 1 : -0.5));
  const [blo, bhi] = meanRange(big);
  assert.ok(blo > 0.1 && bhi < 0.4, 'large samples use z and are narrow');
});

test('confidenceFor bundles it all', () => {
  const c = confidenceFor(4, 3, [1, 1, 1, -1], [2, -1]);
  assert.equal(c.level, 'insufficient');
  assert.deepEqual(c.winRateRange, [30.1, 95.4]);
  assert.ok(c.avgRange[0] < 0 && c.avgRange[1] > 1);
  assert.equal(c.rTrades, 2);
});
