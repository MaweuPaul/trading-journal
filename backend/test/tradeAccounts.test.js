const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAccountIdentity, summarizeTradeAccounts, tradeMatchesAccountFilter } = require('../lib/tradeAccounts');

test('normalizes a stable account key from broker server and login', () => {
  assert.deepEqual(normalizeAccountIdentity({
    accountLogin: 123456,
    accountServer: 'Broker-Live',
    accountName: 'Primary account',
    accountType: 'LIVE',
  }), {
    accountKey: 'broker-live::123456',
    accountLogin: '123456',
    accountServer: 'Broker-Live',
    accountName: 'Primary account',
    accountType: 'live',
  });
});

test('summarizes exact accounts separately even when both are live', () => {
  const summary = summarizeTradeAccounts([
    { accountKey: 'broker::100', accountLogin: '100', accountServer: 'Broker', accountName: 'Main', accountType: 'live' },
    { accountKey: 'broker::100', accountLogin: '100', accountServer: 'Broker', accountName: 'Main', accountType: 'live' },
    { accountKey: 'broker::200', accountLogin: '200', accountServer: 'Broker', accountName: 'Funded', accountType: 'live' },
    { accountType: 'demo' },
  ]);
  assert.equal(summary.accounts.length, 2);
  assert.equal(summary.accounts.find(account => account.accountKey === 'broker::100').count, 2);
  assert.equal(summary.accounts.find(account => account.accountKey === 'broker::200').count, 1);
  assert.equal(summary.unassignedCount, 1);
});

test('matches exact and legacy account filters', () => {
  assert.equal(tradeMatchesAccountFilter({ accountKey: 'broker::100' }, 'BROKER::100'), true);
  assert.equal(tradeMatchesAccountFilter({ accountKey: 'broker::200' }, 'broker::100'), false);
  assert.equal(tradeMatchesAccountFilter({ accountType: 'demo' }, '__unassigned__'), true);
  assert.equal(tradeMatchesAccountFilter({ accountKey: 'broker::100' }, '__unassigned__'), false);
});
