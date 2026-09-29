const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal: { fetchWindows, WINDOW_BARS } } = require('../lib/ctraderReplay');

// A 15m market with weekends closed, and a fake cTrader that answers with at
// most 1500 bars -- counting from either end of the window.
const BAR = 900e3;
const all = [];
for (let t = Date.UTC(2025, 9, 1); t < Date.UTC(2026, 3, 1); t += BAR) {
  const day = new Date(t).getUTCDay();
  if (day !== 0 && day !== 6) all.push(t);
}
const fake = oldestFirst => async (a, b) => {
  const inWindow = all.filter(t => t >= a && t < b);
  const page = oldestFirst ? inWindow.slice(0, 1500) : inWindow.slice(-1500);
  return { trendbar: page.map(t => ({ utcTimestampInMinutes: t / 60000 })) };
};

for (const oldestFirst of [false, true]) {
  test(`windows cover the whole range with no holes (cTrader counting ${oldestFirst ? 'from the oldest' : 'from the newest'} bar)`, async () => {
    const fromMs = Date.UTC(2025, 9, 1), toMs = Date.UTC(2026, 2, 1);
    const bars = await fetchWindows(fake(oldestFirst), { fromMs, toMs, barMs: BAR, pages: 16 });
    const got = new Set(bars.map(b => b.utcTimestampInMinutes * 60000));
    const want = all.filter(t => t >= fromMs && t < toMs);
    assert.ok(want.length > 1500 * 5, 'spans many pages');
    assert.equal(want.filter(t => !got.has(t)).length, 0);
  });
}

test('the page budget keeps the newest bars', async () => {
  const toMs = Date.UTC(2026, 2, 1);
  const bars = await fetchWindows(fake(true), { fromMs: Date.UTC(2025, 9, 1), toMs, barMs: BAR, pages: 2 });
  const times = bars.map(b => b.utcTimestampInMinutes * 60000);
  assert.ok(Math.min(...times) >= toMs - 2 * WINDOW_BARS * BAR);
  assert.ok(Math.max(...times) >= toMs - 3 * 86400e3);
});
