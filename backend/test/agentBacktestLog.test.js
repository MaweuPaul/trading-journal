const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../fixtures/agentReplayHarness');
const log = require('../lib/agentBacktestLog');

const base = { symbol: 'XAUUSD', interval: '15min', direction: 'long', entryPrice: 2000, exitPrice: 2010, stopLoss: 1995, riskAmount: 100 };
async function seed(user) {
  const t = (i, extra) => H.models.Trade.create({ ...base, user, entryTime: Date.UTC(2024, 0, 8 + i, 10) / 1000, exitTime: Date.UTC(2024, 0, 8 + i, 12) / 1000, ...extra });
  const rows = [
    ['agent', 'win', 2], ['agent', 'loss', -1], ['agent', 'loss', -1], ['agent', 'win', 1.5], ['agent', 'breakeven', 0],
    ['replay', 'win', 5], ['quick', 'loss', -1],
  ];
  const ids = [];
  for (const [i, [source, outcome, r]] of rows.entries()) {
    ids.push(String((await t(i, { source, outcome, rMultiple: r, pnlUSD: r * 100, strategy: 'S', tags: ['S'], name: `${source} ${i}`, notes: source === 'replay' ? 'my own words' : '' }))._id));
  }
  const blind = await t(20, { source: 'agent', blind: true, outcome: 'win', rMultiple: 1, strategy: 'S', tags: ['S'], name: 'blind one' });
  return { ids, blindId: String(blind._id) };
}

test('metrics match the Metrics page formulas, filtered and grouped', async () => {
  const user = H.newUserId();
  await seed(user);
  const m = await log.getMetrics(user, {});
  assert.equal(m.overall.trades, 6, 'agent source only by default (incl. the blind trade)');
  const agentOnly = await log.getMetrics(user, { to: '2024-02-01' });
  assert.equal(agentOnly.overall.trades, 5, 'date filters exclude blind trades');
  const o = agentOnly.overall;
  assert.equal(o.winRate, 40);
  assert.equal(o.totalR, 1.5);
  assert.equal(o.profitFactor, 1.75);
  assert.equal(o.maxDrawdownR, 2);
  assert.equal(o.avgWinR, 1.75);
  assert.equal(o.avgLossR, -1);
  assert.equal(o.maxLossStreak, 2);
  assert.equal(o.bestR, 2);
  const all = await log.getMetrics(user, { source: 'all', groupBy: ['source', 'weekday', 'month'] });
  assert.equal(all.overall.trades, 8);
  assert.deepEqual(all.breakdowns.source.map(g => [g.source, g.trades]), [['agent', 6], ['replay', 1], ['quick', 1]]);
  assert.ok(all.breakdowns.month.some(g => g.month === '(blind)'), 'blind trades never reveal their month');
  await assert.rejects(log.getMetrics(user, { groupBy: ['planet'] }), /groupBy must be/);
  await assert.rejects(log.getMetrics(user, { source: 'x' }), /source must be/);
});

test('list and get: filters, paging, and blind trades stay hidden', async () => {
  const user = H.newUserId();
  const { ids, blindId } = await seed(user);
  const page = await log.listBacktests(user, { limit: 3 });
  assert.equal(page.total, 8);
  assert.equal(page.backtests.length, 3);
  assert.match(page.next, /offset: 3/);
  assert.equal((await log.listBacktests(user, { source: 'replay' })).total, 1);
  assert.equal((await log.listBacktests(user, { outcome: 'loss' })).total, 3);
  assert.equal((await log.listBacktests(user, { sort: 'best' })).backtests[0].rMultiple, 5);

  const blind = (await log.listBacktests(user, {})).backtests.find(t => t.id === blindId);
  for (const key of ['entryTime', 'exitTime', 'entryPrice', 'exitPrice', 'stopLoss']) assert.equal(blind[key], undefined, key);
  assert.equal(blind.rMultiple, 1);

  const own = await log.getBacktest(user, ids[5]);
  assert.equal(own.backtest.notes, 'my own words');
  assert.equal(own.backtest.entryTime, '2024-01-13T10:00Z');
  assert.equal(own.snapshot, null);
  H.models.Trade.store.get(blindId).snapshot = 'data:image/png;base64,AAAA';
  assert.equal((await log.getBacktest(user, blindId)).snapshot, null, 'a blind trade\'s chart would show real prices');
  await assert.rejects(log.getBacktest(H.newUserId(), ids[0]), /not found/);
});

test('updates edit journal fields only; deletes are limited to agent trades', async () => {
  const user = H.newUserId();
  const { ids } = await seed(user);
  const owners = ids[5];
  const res = await log.updateBacktest(user, owners, { appendNotes: 'Agent review: late entry.', setupQuality: 9, tags: ['#New', 'x'], entryPrice: 1 });
  assert.equal(res.updated.notes, 'my own words\n\nAgent review: late entry.');
  assert.equal(res.updated.setupQuality, 5);
  assert.equal(res.updated.strategy, 'New');
  assert.equal(res.updated.entryPrice, 2000, 'prices are not editable');
  await assert.rejects(log.updateBacktest(user, owners, {}), /Nothing to update/);

  await assert.rejects(log.deleteBacktest(user, owners), err => err.code === 'FORBIDDEN');
  await assert.rejects(log.deleteBacktest(user, ids[6]), err => err.code === 'FORBIDDEN');
  assert.equal((await log.deleteBacktest(user, ids[0])).deleted, true);
  assert.equal(H.models.Trade.store.has(ids[0]), false);
  assert.equal(H.models.Trade.store.has(owners), true);
});

test('deleting a strategy removes only its definition', async () => {
  const user = H.newUserId();
  await H.models.Strategy.create({ user, name: 'Temp', description: 'x' });
  assert.equal((await log.deleteStrategy(user, '#Temp')).deleted, true);
  await assert.rejects(log.deleteStrategy(user, 'Temp'), err => err.code === 'NOT_FOUND');
});

test('bulk delete: only agent trades, counted first, by strategy or run', async () => {
  const user = H.newUserId();
  const { ids, blindId } = await seed(user);
  await assert.rejects(log.deleteBacktests(user, {}), /strategy or a runId/);
  const preview = await log.deleteBacktests(user, { strategy: 'S' });
  assert.equal(preview.wouldDelete, 6, '5 agent trades + the blind one; not the replay or quick ones');
  assert.equal(H.models.Trade.store.size >= 8, true, 'a preview deletes nothing');
  assert.ok(ids.every(id => H.models.Trade.store.has(id)));

  // One run's trades: recorded on the trade, or (older ones) named in its notes.
  const mk = extra => H.models.Trade.create({ ...base, user, source: 'agent', outcome: 'win', rMultiple: 1, entryTime: 1, exitTime: 2, strategy: 'R', tags: ['R'], ...extra });
  const a = await mk({ strategyRun: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  const b = await mk({ notes: 'Setup...\n\nLogged by strategy run aaaaaaaaaaaaaaaaaaaaaaaa (long Plus).' });
  const c = await mk({ strategyRun: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
  const own = await mk({ source: 'replay', notes: 'strategy run aaaaaaaaaaaaaaaaaaaaaaaa' });
  const byRun = await log.deleteBacktests(user, { runId: 'aaaaaaaaaaaaaaaaaaaaaaaa', confirm: true });
  assert.equal(byRun.deleted, 2);
  for (const t of [a, b]) assert.equal(H.models.Trade.store.has(String(t._id)), false);
  for (const t of [c, own]) assert.equal(H.models.Trade.store.has(String(t._id)), true);

  const all = await log.deleteBacktests(user, { strategy: 'S', confirm: true });
  assert.equal(all.deleted, 6);
  assert.equal(H.models.Trade.store.has(blindId), false);
  assert.equal(H.models.Trade.store.has(ids[5]), true, "the owner's replay backtest stays");
  assert.equal(H.models.Trade.store.has(ids[6]), true, "the owner's quick log stays");
});
