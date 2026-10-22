// Agent replay realism: spread and commission on fills and exits, and the
// economic calendar seen from the replay clock (no actuals before release).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../fixtures/agentReplayHarness');
const replay = require('../lib/agentReplay');

const start = (user, extra = {}) => replay.startSession(user, null, { symbol: 'XAUUSD', interval: '5min', from: '2024-01-09T00:00Z', to: '2024-01-31T00:00Z', context: 5, ...extra });
const near = (a, b) => Math.abs(a - b) < 1e-3; // the tools report R to 3 decimals

test('a long buys at the ask; a short closes at the ask; commission comes off the R and P/L', async () => {
  const user = H.newUserId();
  const s = await start(user, { costs: { spread: 0.5, commission: 10 } });
  assert.deepEqual(s.costs, { spread: 0.5, commission: 10 });
  await replay.step(user, s.sessionId, { untilTime: '2024-01-09T10:00Z' });
  const last = (await replay.getState(user, s.sessionId)).lastCandle;

  const long = await replay.openTrade(user, s.sessionId, { direction: 'long', stopLoss: last.close - 5, riskAmount: 100 });
  assert.ok(near(long.opened.entryPrice, last.close + 0.5), 'long entry = bid close + spread');
  const closedLong = await replay.closeTrade(user, s.sessionId);
  // Exits a long at the bid: -0.5 of spread on a 5.5 risk, then $10 of commission on $100 risk.
  assert.ok(near(closedLong.closed.exitPrice, last.close));
  assert.ok(near(closedLong.closed.rMultiple, -0.5 / 5.5 - 0.1));
  assert.ok(Math.abs(closedLong.closed.pnlUSD - (-0.5 / 5.5 - 0.1) * 100) < 0.01, "P/L is reported to the cent");
  await replay.discardTrade(user, s.sessionId);

  const short = await replay.openTrade(user, s.sessionId, { direction: 'short', stopLoss: last.close + 5, riskAmount: 100 });
  assert.ok(near(short.opened.entryPrice, last.close), 'short entry at the bid');
  const closedShort = await replay.closeTrade(user, s.sessionId);
  assert.ok(near(closedShort.closed.exitPrice, last.close + 0.5), 'short buys back at the ask');
  assert.ok(near(closedShort.closed.rMultiple, -0.5 / 5 - 0.1));
});

test('without costs nothing changes', async () => {
  const user = H.newUserId();
  const s = await start(user);
  assert.deepEqual(s.costs, { spread: 0, commission: 0 });
  await replay.step(user, s.sessionId, { untilTime: '2024-01-09T10:00Z' });
  const last = (await replay.getState(user, s.sessionId)).lastCandle;
  const t = await replay.openTrade(user, s.sessionId, { direction: 'long', stopLoss: last.close - 5 });
  assert.ok(near(t.opened.entryPrice, last.close));
  assert.ok(near((await replay.closeTrade(user, s.sessionId)).closed.rMultiple, 0));
});

test('get_news: released events with actuals, upcoming ones without, for the symbol\'s currencies', async () => {
  const user = H.newUserId();
  const ev = (key, iso, extra) => H.models.News.create({ key, source: 'mql5', currency: 'USD', name: key, impact: 'High', time: new Date(iso), forecast: '1.0', previous: '0.9', ...extra });
  await ev('CPI', '2024-01-09T08:30Z', { actual: '1.2' });
  await ev('Fed Chair', '2024-01-09T11:00Z', { actual: 'should never show' });
  await ev('EUR thing', '2024-01-09T09:00Z', { currency: 'EUR', actual: '5' });
  await ev('Medium one', '2024-01-09T12:00Z', { impact: 'Medium' });

  const s = await start(user);
  await replay.step(user, s.sessionId, { untilTime: '2024-01-09T10:00Z' });
  const news = await replay.getNews(user, s.sessionId, {});
  assert.deepEqual(news.currencies, ['USD']);
  const cpi = news.events.find(e => e.name === 'CPI');
  assert.equal(cpi.actual, '1.2');
  assert.equal(cpi.minutesAgo, 90);
  const fed = news.events.find(e => e.name === 'Fed Chair');
  assert.equal(fed.actual, undefined, 'no actual before release');
  assert.equal(fed.minutesUntil, 60);
  assert.equal(fed.forecast, '1.0');
  assert.ok(!news.events.some(e => e.name === 'EUR thing'), 'XAUUSD follows USD only');
  assert.ok(!news.events.some(e => e.name === 'Medium one'), 'high impact by default');
  assert.equal(news.nextHighImpact.name, 'Fed Chair');
  assert.ok((await replay.getNews(user, s.sessionId, { impact: 'all' })).events.some(e => e.name === 'Medium one'));
});

test('get_news in a blind session leaves the figures out', async () => {
  const user = H.newUserId();
  await H.models.News.create({ key: 'NFP-blind', source: 'mql5', currency: 'USD', name: 'NFP', impact: 'High', time: new Date('2024-01-12T13:30Z'), actual: '200K', forecast: '180K' });
  const s = await replay.startSession(user, null, { symbol: 'XAUUSD', interval: '5min', blind: true, lengthDays: 10, from: '2024-01-09T00:00Z', to: '2024-01-31T00:00Z' });
  const news = await replay.getNews(user, s.sessionId, { lookBackHours: 336, lookAheadHours: 336 });
  for (const e of news.events) { assert.equal(e.actual, undefined); assert.equal(e.forecast, undefined); }
  assert.match(news.note || '', /Blind session/);
});
