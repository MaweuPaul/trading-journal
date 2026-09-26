const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../fixtures/agentReplayHarness');
const replay = require('../lib/agentReplay');
const log = require('../lib/agentBacktestLog');

const toSec = iso => Date.parse(iso) / 1000;

/** Run a session placing simple trades, logging each with a feature. */
async function trade(user, { from, to, strategy, n, features = () => ({}) }) {
  const s = await replay.startSession(user, null, { symbol: 'XAUUSD', interval: '15min', from, to, strategy, context: 20 });
  const ids = [];
  for (let i = 0; i < n; i++) {
    const st = await replay.getState(user, s.sessionId);
    if (st.status !== 'active' || st.progressPct >= 100) break;
    const entry = st.lastCandle.close;
    await replay.openTrade(user, s.sessionId, { direction: i % 2 ? 'short' : 'long', stopLoss: i % 2 ? entry + 2 : entry - 2, takeProfit: i % 2 ? entry - 2 : entry + 2, features: features(i) });
    const res = await replay.step(user, s.sessionId, { bars: 2000 });
    if (!res.events.some(e => e.type === 'trade_closed')) await replay.closeTrade(user, s.sessionId);
    ids.push((await replay.logTrade(user, s.sessionId, { features: { index: i } })).tradeId);
    await replay.step(user, s.sessionId, { bars: 4 });
  }
  await replay.endSession(user, s.sessionId);
  return ids;
}

test('entry conditions are recorded, filterable and groupable', async () => {
  const user = H.newUserId();
  await H.models.Strategy.create({ user, name: 'F', description: 'test' });
  const ids = await trade(user, { from: '2024-01-08', to: '2024-02-01', strategy: 'F', n: 16, features: i => ({ rangeWidth: i, session: i % 2 ? 'NY' : 'London' }) });
  const t = H.models.Trade.store.get(ids[3]);
  assert.equal(t.features.rangeWidth, 3);
  assert.equal(t.features.session, 'NY');
  assert.equal(t.features.index, 3, 'log_trade features merge with entry features');
  assert.ok(t.features.atr14 > 0 && t.features.riskInAtr > 0, 'atr14 and riskInAtr are automatic');
  assert.ok(Math.abs(t.features.riskInAtr - 2 / t.features.atr14) < 0.01);
  assert.equal(t.strategyVersion, 1);

  const m = await log.getMetrics(user, { strategy: 'F', groupBy: ['feature:rangeWidth', 'feature:session', 'version'] });
  assert.equal(m.breakdowns['feature:rangeWidth'].length, 4, 'numeric features split into quartiles');
  assert.equal(m.breakdowns['feature:rangeWidth'].reduce((a, g) => a + g.trades, 0), ids.length);
  assert.deepEqual(m.breakdowns['feature:session'].map(g => g['feature:session']).sort(), ['London', 'NY']);
  assert.equal(m.breakdowns.version[0].version, 'F v1');

  const narrow = await log.getMetrics(user, { strategy: 'F', where: [{ feature: 'rangeWidth', max: 4 }, { feature: 'session', equals: 'NY' }] });
  assert.equal(narrow.overall.trades, 2, 'rangeWidth 1 and 3');

  await assert.rejects(replay.openTrade(user, 'x', {}), /Unknown session/);
  assert.throws(() => replay.normalizeFeatures({ 'bad name': 1 }), /must be letters/);
  assert.throws(() => replay.normalizeFeatures({ x: { nested: 1 } }), /must be a number/);
});

test('versions, a held-out period and evaluate_holdout', async () => {
  const user = H.newUserId();
  await H.models.Strategy.create({ user, name: 'R', description: 'v1 rules' });
  await trade(user, { from: '2024-01-08', to: '2024-01-31', strategy: 'R', n: 10 });

  const hold = await log.setHoldout(user, { name: 'R', from: '2024-02-01' });
  assert.equal(hold.holdoutFrom, '2024-02-01');
  await assert.rejects(log.updateStrategyRules(user, { name: 'R', rules: 'v2 rules' }), /change is required/);
  const v2 = await log.updateStrategyRules(user, { name: 'R', rules: 'v2 rules', change: 'Tighter stops after Q4 losses' });
  assert.equal(v2.version, 2);
  assert.equal(v2.warning, undefined, 'no held-out peeks yet');

  // v2 trades before and after the held-out date
  await trade(user, { from: '2024-01-15', to: '2024-01-31', strategy: 'R', n: 8 });
  const heldIds = await trade(user, { from: '2024-02-05', to: '2024-03-15', strategy: 'R', n: 25 });

  // Held-out results are hidden everywhere except evaluate_holdout.
  const listed = await log.listBacktests(user, { strategy: 'R' });
  assert.ok(listed.backtests.every(b => !heldIds.includes(b.id)));
  assert.match(listed.heldOut, /25 trade/);
  const metrics = await log.getMetrics(user, { strategy: 'R', groupBy: ['version'] });
  assert.match(metrics.heldOut, /25 trade/);
  await assert.rejects(log.getBacktest(user, heldIds[0]), err => err.code === 'HELD_OUT');

  const ev = await log.evaluateHoldout(user, { name: 'R' });
  assert.equal(ev.version, 2);
  assert.equal(ev.outOfSample.trades, 25);
  assert.equal(ev.inSample.trades, 8);
  assert.ok(ev.verdict.length > 10);
  assert.equal(ev.evaluations, 1);

  const s = await log.getStrategy(user, 'R');
  assert.equal(s.currentVersion, 2);
  assert.deepEqual(s.versions.map(v => v.version), [1, 2]);
  assert.equal(s.versions[0].inSample.trades, 10);
  assert.equal(s.versions[1].holdoutResult.outOfSample.trades, 25, 'first evaluation frozen into the history');
  assert.equal(s.holdout.evaluations, 1);

  // A version written after peeking is flagged, and later peeks are counted.
  const v3 = await log.updateStrategyRules(user, { name: 'R', rules: 'v3', change: 'after seeing holdout' });
  assert.match(v3.warning, /not be clean|not clean|marked/);
  assert.ok((await log.getStrategy(user, 'R')).versions[2].warning);
  for (let i = 0; i < 3; i++) await log.evaluateHoldout(user, { name: 'R', version: 2 });
  const again = await log.evaluateHoldout(user, { name: 'R', version: 2 });
  assert.match(again.warning, /5 times/);
  assert.equal((await log.getStrategy(user, 'R')).versions[1].holdoutResult.evaluatedAt, ev.evaluatedAt, 'the first look stays frozen');
});

test('new sessions trade the latest version; research needs an existing strategy', async () => {
  const user = H.newUserId();
  await H.models.Strategy.create({ user, name: 'V', description: 'x' });
  await log.updateStrategyRules(user, { name: 'V', rules: 'v2', change: 'c' });
  const ids = await trade(user, { from: '2024-01-08', to: '2024-01-20', strategy: 'V', n: 2 });
  assert.equal(H.models.Trade.store.get(ids[0]).strategyVersion, 2);
  await assert.rejects(log.getStrategy(user, 'Nope'), err => err.code === 'NOT_FOUND');
  await assert.rejects(log.evaluateHoldout(user, { name: 'V' }), /no held-out period/);
});
