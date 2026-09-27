const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../fixtures/agentReplayHarness');
const { buildExport } = require('../lib/journalExport');

async function seed(user) {
  const t = (i, extra) => H.models.JournalTrade.create({
    user, dealId: `x${i}`, symbol: 'XAUUSD', direction: 'BUY', entryPrice: 2000, exitPrice: 2005, lotSize: 1,
    openTime: new Date(Date.UTC(2024, 0, 8 + i, 14, 5)), closeTime: new Date(Date.UTC(2024, 0, 8 + i, 15)),
    durationMinutes: 55, accountKey: 'ctrader:1', accountName: 'Main', accountType: 'live', ...extra,
  });
  await t(0, { pnlUSD: 200, riskUSD: 100, primarySetup: 'ORB', emotion: 'Calm', notes: 'clean | retest\nsecond line', checklist: [{ rule: 'Wait for close', complied: true }] });
  await t(1, { pnlUSD: -100, riskUSD: 100, primarySetup: 'ORB', emotion: 'FOMO', exitReason: 'SL', checklist: [{ rule: 'Wait for close', complied: false }], screenshots: [{ url: 'https://img.example/1.png', publicId: 'p', caption: 'entry' }] });
  await t(2, { pnlUSD: 150, riskUSD: 100, primarySetup: 'FVG', direction: 'SELL', accountType: 'demo' });
  H.models.User.store.set(user, { _id: user, playbooks: [{ name: 'NY ORB', versions: [{ versionNumber: 3, blocks: [{ name: 'Entry', category: 'setup', rules: [{ label: 'Wait for a 5m close', inputType: 'boolean' }] }] }] }] });
}

test('the AI export carries the brief, stats with ranges, breakdowns, playbook and each trade\'s journal', async () => {
  const user = H.newUserId();
  await seed(user);
  const { markdown, trades, listed } = await buildExport(user, {});
  assert.equal(trades, 3);
  assert.equal(listed, 3);
  assert.match(markdown, /## What I want from you/);
  assert.match(markdown, /\| All trades \| 3 \| insufficient \| 66\.7% \(/);
  assert.match(markdown, /### Setup\n\| Group/);
  assert.match(markdown, /\| ORB \| 2 \|/);
  assert.match(markdown, /### Rules followed/);
  assert.match(markdown, /### NY ORB \(v3\)\n- \*\*Entry\*\*: Wait for a 5m close/);
  assert.match(markdown, /Rules broken \(1\/1\): Wait for close/);
  assert.match(markdown, /Notes: clean \| retest \/ second line/);
  assert.match(markdown, /Screenshots: https:\/\/img\.example\/1\.png \(entry\)/);
  assert.ok(markdown.indexOf('2024-01-10') < markdown.indexOf('2024-01-08 14:05'), 'newest first');
  assert.equal(markdown.includes('publicId'), false);
});

test('filters, trade limit and leaving out the journal text', async () => {
  const user = H.newUserId();
  await seed(user);
  const live = await buildExport(user, { accountType: 'live' });
  assert.equal(live.trades, 2);
  const short = await buildExport(user, { direction: 'short' });
  assert.equal(short.trades, 1);
  const statsOnly = await buildExport(user, { maxTrades: 0 });
  assert.equal(statsOnly.listed, 0);
  assert.equal(statsOnly.markdown.includes('## Trades'), false);
  const bare = await buildExport(user, { notes: false });
  assert.equal(bare.markdown.includes('Notes: clean'), false);
  assert.equal(bare.markdown.includes('Screenshots:'), false);
  assert.match(bare.markdown, /Rules broken/, 'checklists stay (they are numbers, not prose)');
});
