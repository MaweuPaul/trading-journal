const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';
const H = require('../fixtures/agentReplayHarness');
const journal = require('../lib/agentJournal');
const express = require('express');

// Five real trades: three wins, two losses; one with commission turning a tiny win into a loss.
async function seed(user) {
  const t = (i, extra) => H.models.JournalTrade.create({
    user, dealId: `d${i}`, symbol: 'XAUUSD', direction: 'BUY', entryPrice: 2000, exitPrice: 2005, lotSize: 1,
    openTime: new Date(Date.UTC(2024, 0, 8 + i, 14, 5)), closeTime: new Date(Date.UTC(2024, 0, 8 + i, 15)),
    durationMinutes: 55, accountKey: 'ctrader:1', accountName: 'Main', accountType: 'live', ...extra,
  });
  const ids = [];
  ids.push((await t(0, { pnlUSD: 200, riskUSD: 100, primarySetup: 'ORB', emotion: 'Calm', notes: 'clean retest', checklist: [{ rule: 'Wait for close', complied: true }] }))._id);
  ids.push((await t(1, { pnlUSD: -100, riskUSD: 100, primarySetup: 'ORB', emotion: 'FOMO', exitReason: 'SL', checklist: [{ rule: 'Wait for close', complied: false }] }))._id);
  ids.push((await t(2, { pnlUSD: 150, riskUSD: 100, primarySetup: 'FVG', tags: ['A+'] }))._id);
  ids.push((await t(3, { pnlUSD: 5, commission: -7, primarySetup: 'FVG', direction: 'SELL' }))._id);
  ids.push((await t(4, {
    pnlUSD: 80, primarySetup: 'ORB', accountKey: 'demo:2', accountName: 'Demo', accountType: 'demo',
    screenshots: [{ url: 'https://example.invalid/a.png', publicId: 'secret-public-id', caption: 'entry' }],
    playbookSnapshot: { name: 'NY ORB', versionNumber: 2, blocks: [{ name: 'Setup', rules: [{ ruleId: 'r1', label: 'Range under 10 points' }, { ruleId: 'r2', label: 'Bias' }] }] },
    playbookResponses: { r1: true, r2: { value: 'long' } },
  }))._id);
  return ids.map(String);
}

test('list_trades filters, sorts and pages; costs decide the outcome', async () => {
  const user = H.newUserId();
  await seed(user);
  await seed(H.newUserId()); // someone else's trades never show up
  const all = await journal.listTrades(user, {});
  assert.equal(all.total, 5);
  assert.equal(all.trades[0].closeTime, '2024-01-12T15:00:00.000Z', 'newest first');
  assert.equal((await journal.listTrades(user, { outcome: 'loss' })).total, 2, 'the +5 trade with -7 commission is a loss');
  assert.equal((await journal.listTrades(user, { setup: 'orb' })).total, 3, 'setup match ignores case');
  assert.equal((await journal.listTrades(user, { account: 'demo:2' })).total, 1);
  assert.equal((await journal.listTrades(user, { direction: 'short' })).total, 1);
  assert.equal((await journal.listTrades(user, { from: '2024-01-10', to: '2024-01-11T23:00:00Z' })).total, 2);
  assert.equal((await journal.listTrades(user, { journaled: true })).total, 1);
  const worst = await journal.listTrades(user, { sort: 'worst', limit: 2, offset: 0 });
  assert.deepEqual(worst.trades.map(t => t.netUSD), [-100, -2]);
  const first = all.trades.find(t => t.netUSD === 200);
  assert.equal(first.r, 2);
  assert.equal(first.hasNotes, true);
  assert.equal(first.notes, undefined, 'notes only on get_trade');
});

test('an account renamed after sync stays one account; lot sizes lose float noise', async () => {
  const user = H.newUserId();
  const trade = (i, accountName, lotSize) => H.models.JournalTrade.create({
    user, dealId: `n${i}`, symbol: 'NAS100', direction: 'SELL', entryPrice: 20000, exitPrice: 19990, lotSize, pnlUSD: 10,
    openTime: new Date(Date.UTC(2024, 0, 8 + i, 14)), closeTime: new Date(Date.UTC(2024, 0, 8 + i, 14, 30)),
    durationMinutes: 30, accountKey: 'ctrader:7', accountName, accountType: 'live',
  });
  await trade(0, 'cTrader Live', 0.30000000000000004);
  await trade(1, 'cTrader Live (tradinghive)', 0.09999999999999999);
  await H.models.TradingAccount.create({ user, provider: 'ctrader', accountKey: 'ctrader:7', label: 'cTrader Live (tradinghive)' });
  const metrics = await journal.getMetrics(user, { groupBy: 'account' });
  assert.deepEqual(metrics.breakdowns.account.map(g => [g.account, g.trades]), [['cTrader Live (tradinghive)', 2]]);
  const { trades } = await journal.listTrades(user, { sort: 'oldest' });
  assert.deepEqual(trades.map(t => t.account), ['cTrader Live (tradinghive)', 'cTrader Live (tradinghive)']);
  assert.deepEqual(trades.map(t => t.lots), [0.3, 0.1]);
});

test('get_trade: full journal, playbook answers, never another user\'s trade', async () => {
  const user = H.newUserId();
  const ids = await seed(user);
  const { trade } = await journal.getTrade(user, ids[4]);
  assert.deepEqual(trade.playbookAnswers, { name: 'NY ORB', version: 2, answers: [
    { block: 'Setup', rule: 'Range under 10 points', answer: true },
    { block: 'Setup', rule: 'Bias', answer: 'long' },
  ] });
  assert.equal(trade.screenshots[0].caption, 'entry');
  assert.equal(JSON.stringify(trade).includes('secret-public-id'), false, 'Cloudinary public ids stay private');
  const { trade: broke } = await journal.getTrade(user, ids[1]);
  assert.equal(broke.rulesBroken, 1);
  await assert.rejects(journal.getTrade(H.newUserId(), ids[0]), /not found/);
  await assert.rejects(journal.getTrade(user, 'nope'), /not found/);
});

test('metrics: net of costs, R only where the stop is known, breakdowns with ranges', async () => {
  const user = H.newUserId();
  await seed(user);
  const m = await journal.getMetrics(user, { groupBy: ['setup', 'rulesFollowed', 'session', 'account'] });
  const o = m.overall;
  assert.equal(o.trades, 5);
  assert.equal(o.wins, 3);
  assert.equal(o.losses, 2);
  assert.equal(o.netUSD, 328);
  assert.equal(o.profitFactor, 4.22);
  assert.equal(o.rTrades, 3);
  assert.equal(o.avgR, 0.833);
  assert.equal(o.maxDrawdownUSD, 100);
  assert.equal(o.confidence.level, 'insufficient');
  assert.equal(o.confidence.winRateRange.length, 2);
  const bySetup = Object.fromEntries(m.breakdowns.setup.map(g => [g.setup, g.trades]));
  assert.deepEqual(bySetup, { ORB: 3, FVG: 2 });
  const rules = Object.fromEntries(m.breakdowns.rulesFollowed.map(g => [g.rulesFollowed, g.netUSD]));
  assert.deepEqual(rules, { 'followed all': 200, 'broke a rule': -100, '(no checklist)': 228 });
  assert.equal(m.breakdowns.session[0].session, 'London/NY Overlap');
  assert.deepEqual(m.breakdowns.account.map(g => g.account).sort(), ['Demo', 'Main']);
  await assert.rejects(journal.getMetrics(user, { groupBy: ['nonsense'] }), /groupBy/);
});

test('accounts, playbooks and candles around a trade', async () => {
  const user = H.newUserId();
  const ids = await seed(user);
  const { accounts } = await journal.listAccounts(user);
  assert.deepEqual(accounts.map(a => [a.account, a.trades]), [['ctrader:1', 4], ['demo:2', 1]]);

  H.models.User.store.set(user, { _id: new mongoose.Types.ObjectId(user), playbooks: [
    { name: 'NY ORB', versions: [{ versionNumber: 1, blocks: [] }, { versionNumber: 2, blocks: [{ name: 'Setup', category: 'setup', rules: [{ label: 'Range under 10 points', inputType: 'boolean' }] }] }] },
    { name: 'Old', archived: true, versions: [] },
  ] });
  const { playbooks } = await journal.getPlaybooks(user);
  assert.equal(playbooks.length, 1, 'archived playbooks are left out');
  assert.equal(playbooks[0].version, 2);
  assert.equal(playbooks[0].blocks[0].rules[0].rule, 'Range under 10 points');

  const c = await journal.getTradeCandles(user, ids[0], { barsBefore: 20, barsAfter: 5 });
  assert.equal(c.interval, '5min', '55 minutes open -> 5-minute candles');
  assert.deepEqual(c.columns, ['time', 'open', 'high', 'low', 'close']);
  const times = c.candles.map(k => k[0]);
  assert.equal(times.filter(t => t < '2024-01-08T14:05Z').length, 20, '20 bars before the entry candle');
  assert.equal(times.filter(t => t > '2024-01-08T15:00Z').length, 5, '5 bars after the exit candle');
  assert.ok(c.candles.length <= 600);

  // A 2-minute trade gets 1-minute candles over a window of several thousand
  // bars, more than one 1500-bar cTrader page: the bars before entry must still be there.
  const quick = String((await H.models.JournalTrade.create({
    user, dealId: 'q1', symbol: 'XAUUSD', direction: 'SELL', entryPrice: 2000, exitPrice: 1999, lotSize: 1, pnlUSD: 10,
    openTime: new Date(Date.UTC(2024, 0, 10, 14, 1)), closeTime: new Date(Date.UTC(2024, 0, 10, 14, 3)),
    durationMinutes: 2, accountKey: 'ctrader:1', accountName: 'Main', accountType: 'live',
  }))._id);
  const q = await journal.getTradeCandles(user, quick, { barsBefore: 100, barsAfter: 30 });
  assert.equal(q.interval, '1min');
  const qt = q.candles.map(k => k[0]);
  assert.equal(qt.filter(t => t < '2024-01-10T14:01Z').length, 100, '100 bars before a short trade\'s entry');
  assert.equal(qt[100], '2024-01-10T14:01Z', 'the entry candle follows them');
});

// ── Over MCP: journal tools need the opt-in scope ──────────────────────────
const app = express();
app.use(express.json());
for (const name of ['apiKeys', 'mcp']) app.use('/api', require(`../routes/${name}`));
const owner = H.newUserId();
const ownerToken = jwt.sign({ userId: owner, role: 'owner' }, process.env.JWT_SECRET);
let server, base;
test.before(() => new Promise(resolve => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api`; resolve(); }); }));
test.after(() => server.close());
const asOwner = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}`, ...init.headers } });
async function toolNames(key) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return (await res.json()).result.tools.map(t => t.name);
}

test('journal tools only appear on keys with journal access, which the owner can toggle', async () => {
  const plain = await (await asOwner('/api-keys', { method: 'POST', body: JSON.stringify({ name: 'backtest only' }) })).json();
  assert.equal(plain.journal, false);
  const names = await toolNames(plain.key);
  assert.ok(names.includes('start_session'));
  assert.equal(names.includes('list_trades'), false, 'real trades are opt-in');

  const withJournal = await (await asOwner('/api-keys', { method: 'POST', body: JSON.stringify({ name: 'coach', journal: true }) })).json();
  assert.equal(withJournal.journal, true);
  for (const name of ['list_journal_accounts', 'list_trades', 'get_trade', 'get_journal_metrics', 'get_playbooks', 'get_trade_candles']) {
    assert.ok((await toolNames(withJournal.key)).includes(name), name);
  }

  const toggled = await (await asOwner(`/api-keys/${plain._id}`, { method: 'PATCH', body: JSON.stringify({ journal: true }) })).json();
  assert.equal(toggled.journal, true);
  assert.ok((await toolNames(plain.key)).includes('list_trades'));
  await asOwner(`/api-keys/${plain._id}`, { method: 'PATCH', body: JSON.stringify({ journal: false }) });
  assert.equal((await toolNames(plain.key)).includes('list_trades'), false);
  assert.equal((await asOwner(`/api-keys/${plain._id}`, { method: 'PATCH', body: '{}' })).status, 400);
});

test('knowledge base, pre-trade analyses and cash flows are readable, only the owner\'s', async () => {
  const user = H.newUserId(), other = H.newUserId();
  const k = await H.models.KnowledgeEntry.create({ user, title: 'Asian range', content: 'Gold often sweeps the Asian high before NY.', tags: ['liquidity'] });
  await H.models.KnowledgeEntry.create({ user: other, title: 'not mine', content: 'Asian' });
  const list = await journal.listKnowledge(user, { search: 'asian' });
  assert.equal(list.total, 1);
  assert.equal((await journal.listKnowledge(user, { tag: 'LIQUIDITY' })).total, 1);
  assert.match((await journal.getKnowledgeEntry(user, String(k._id))).entry.content, /sweeps/);
  await assert.rejects(journal.getKnowledgeEntry(other, String(k._id)), /not found/);

  const a = await H.models.PreTradeAnalysis.create({
    user, playbookId: 'p', playbookVersionId: 'v', symbol: 'XAUUSD', direction: 'long', notes: 'wait for the sweep',
    playbookSnapshot: { name: 'NY ORB', versionNumber: 1, blocks: [{ name: 'Plan', rules: [{ ruleId: 'r1', label: 'Bias' }] }] }, responses: { r1: 'long' },
  });
  assert.equal((await journal.listPreTradeAnalyses(user, { status: 'open' })).total, 1);
  const got = (await journal.getPreTradeAnalysis(user, String(a._id))).analysis;
  assert.deepEqual(got.playbookAnswers.answers, [{ block: 'Plan', rule: 'Bias', answer: 'long' }]);

  await H.models.AccountEvent.create({ user, type: 'deposit', amount: 1000, occurredAt: new Date('2024-01-02'), accountKey: 'ctrader:1' });
  await H.models.AccountEvent.create({ user, type: 'withdrawal', amount: -300, occurredAt: new Date('2024-02-02'), accountKey: 'ctrader:1' });
  const ev = await journal.getAccountEvents(user, {});
  assert.deepEqual(ev.totals, { deposits: 1000, withdrawals: 300, adjustments: 0 });
  assert.equal((await journal.getAccountEvents(user, { from: '2024-02-01' })).events.length, 1);
});
