process.env.ACCOUNT_ENCRYPTION_KEY = process.env.ACCOUNT_ENCRYPTION_KEY || 'test-only-account-encryption-key-0123456789';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../fixtures/agentReplayHarness');
const { parseMt5Statement, statementTrades, num, mt5Time } = require('../lib/mt5Statement');
const { importMt5Statement } = require('../lib/mt5StatementImport');
const { encryptCredential } = require('../lib/credentialEncryption');

const { REPORT } = require('../fixtures/mt5Report');

test('number and time formats', () => {
  assert.equal(num('10 000.00'), 10000);
  assert.equal(num('- 100.00'), -100);
  assert.equal(num('0,25'), 0.25);
  assert.ok(Number.isNaN(num('')));
  assert.equal(mt5Time('2024.01.15 12:30:00').toISOString(), '2024-01-15T12:30:00.000Z');
});

test('parses the account, positions (hidden cell skipped) and cash movements', () => {
  const p = parseMt5Statement(REPORT);
  assert.deepEqual(p.account, { login: '12345678', currency: 'USD', server: 'Exness-MT5Real8', accountType: 'live', mode: 'Hedge' });
  assert.equal(p.name, 'Paul Maweu');
  assert.equal(p.positions.length, 3);
  const [gold] = p.positions;
  assert.equal(gold.symbol, 'XAUUSD');
  assert.equal(gold.entryPrice, 2020.5);
  assert.equal(gold.exitPrice, 2040);
  assert.equal(gold.stopLoss, 2010);
  assert.equal(gold.closeTime.toISOString(), '2024-01-15T12:30:00.000Z');
  assert.equal(p.positions[2].profit, -100);
  assert.deepEqual(p.balanceOps.map(e => [e.type, e.amount, e.externalId]), [['deposit', 10000, '5000'], ['withdrawal', 500, '5008']]);
});

test('turns positions into trades using the deals for balance, closing deal and exit', () => {
  const trades = statementTrades(parseMt5Statement(REPORT));
  const [gold, euro, cable] = trades;
  assert.equal(gold.dealId, '5002', 'single close: the closing deal ticket, like the sync app');
  assert.equal(gold.exitTrigger, 'TP');
  assert.equal(gold.runningBalance, 10194.3);
  assert.equal(gold.pnlPct, Math.round((195 / (10194.3 - 195 + 0.7)) * 100 * 10000) / 10000);
  assert.equal(euro.dealId, 'stmt-1002', 'closed in parts: one trade for the position');
  assert.equal(euro.lotSize, 1);
  assert.equal(euro.runningBalance, 10485.8, 'balance after the last part closed');
  assert.equal(cable.exitTrigger, 'SL');
  assert.equal(cable.direction, 'BUY');
  assert.equal(cable.durationMinutes, 105);
});

test('rejects files that are not MT5 reports, with a useful message', () => {
  assert.throws(() => parseMt5Statement('hello world, this is not a report at all, just some text'), /MT5 report/);
  assert.throws(() => parseMt5Statement('<html><table><tr><td>Deals</td></tr></table></html>'.padEnd(80)), /No Positions table/);
});

const userId = '65f000000000000000000abc';

test('preview, import into a new import-only account, then a second import adds nothing', async () => {
  const preview = await importMt5Statement({ userId, content: REPORT });
  assert.equal(preview.positions, 3);
  assert.equal(preview.newTrades, 3);
  assert.equal(preview.matchedAccount, null);
  assert.equal(preview.target.id, 'new');
  assert.equal(H.models.JournalTrade.store.size, 0, 'a preview writes nothing');

  const done = await importMt5Statement({ userId, content: REPORT, commit: true, checklist: [{ ruleId: 'r1', rule: 'Plan', complied: false }] });
  assert.equal(done.inserted, 3);
  assert.equal(done.eventsInserted, 2);
  const account = [...H.models.TradingAccount.store.values()].find(a => a.provider === 'mt5_import');
  assert.equal(account.statementLogin, '12345678');
  assert.equal(account.lastBalance, 9882.3);
  const saved = [...H.models.JournalTrade.store.values()].filter(t => String(t.user) === userId);
  assert.equal(saved.length, 3);
  assert.ok(saved.every(t => t.importSource === 'mt5-statement' && t.accountKey === `mt5import:${account._id}` && t.accountType === 'live'));
  assert.equal(saved[0].checklist.length, 1);

  const again = await importMt5Statement({ userId, content: REPORT, commit: true });
  assert.equal(again.matchedAccount.id, String(account._id), 'the same login finds the same account');
  assert.equal(again.inserted, 0);
  assert.equal(again.eventsInserted, 0);
  assert.equal(again.alreadyInJournal, 3);
});

test('a report for a synced MT5 account skips positions the sync app already added', async () => {
  const owner = '65f000000000000000000def';
  const accountId = '65f0000000000000000000a1';
  await H.models.TradingAccount.create({
    _id: accountId, user: owner, provider: 'mt5', accountKey: `mt5:${accountId}`, label: 'Exness live',
    credentials: {
      login: encryptCredential('12345678', `${owner}:${accountId}:login`),
      password: encryptCredential('secret', `${owner}:${accountId}:password`),
      server: encryptCredential('Exness-MT5Real8', `${owner}:${accountId}:server`),
    },
  });
  await H.models.JournalTrade.create({
    user: owner, accountKey: `mt5:${accountId}`, dealId: '5002', positionId: '1001', symbol: 'XAUUSD', direction: 'BUY',
    entryPrice: 2020.5, exitPrice: 2040, lotSize: 0.1, pnlUSD: 195, openTime: new Date('2024-01-15T10:00:00Z'), closeTime: new Date('2024-01-15T12:30:00Z'),
  });
  const preview = await importMt5Statement({ userId: owner, content: REPORT });
  assert.equal(preview.matchedAccount.id, accountId, 'matched by the synced account\'s login and server');
  assert.equal(preview.newTrades, 2);
  assert.equal(preview.alreadyInJournal, 1);
  const done = await importMt5Statement({ userId: owner, content: REPORT, commit: true });
  assert.equal(done.inserted, 2);
  const mine = [...H.models.JournalTrade.store.values()].filter(t => String(t.user) === owner);
  assert.equal(mine.length, 3);
  assert.ok(mine.every(t => t.accountKey === `mt5:${accountId}`));
});

test('importing into a chosen account, and refusing cTrader accounts', async () => {
  const owner = '65f000000000000000000fed';
  const ct = await H.models.TradingAccount.create({ user: owner, provider: 'ctrader', accountKey: 'ctrader:1', label: 'cT' });
  await assert.rejects(importMt5Statement({ userId: owner, content: REPORT, target: String(ct._id) }), /cTrader/);
  const fresh = await importMt5Statement({ userId: owner, content: REPORT, target: 'new', commit: true });
  assert.equal(fresh.inserted, 3);
});
