const test = require('node:test');
const assert = require('node:assert/strict');
const { findAccountFor, terminalLabel } = require('../lib/terminalAccounts');

const exness = { _id: 'a', provider: 'mt5', creds: { login: '1234', server: 'Exness-MT5Real8' } };
const maven = { _id: 'b', provider: 'mt5_terminal', statementLogin: '10451501', statementServer: 'MavenTrade-Server' };
const imported = { _id: 'c', provider: 'mt5_import', statementLogin: '81888774', statementServer: '' };
const ctrader = { _id: 'd', provider: 'ctrader', statementLogin: '10451501' };
const all = [exness, maven, imported, ctrader];
const creds = a => a.creds || null;

test('matches an account added with its password, by its decrypted login and server', () => {
  assert.equal(findAccountFor(all, '1234', 'exness-mt5real8', creds), exness);
  assert.equal(findAccountFor(all, '1234', 'Other-Server', creds), null);
});

test('matches one found in a terminal before, or imported from a statement', () => {
  assert.equal(findAccountFor(all, 10451501, 'MavenTrade-Server', creds), maven);
  assert.equal(findAccountFor(all, '81888774', 'AnyBroker-Live', creds), imported, 'an import without a server matches any');
});

test('ignores cTrader accounts and unreadable credentials', () => {
  assert.equal(findAccountFor([ctrader], '10451501', 'MavenTrade-Server', creds), null);
  assert.equal(findAccountFor([{ provider: 'mt5' }], '1234', 'Exness-MT5Real8', () => null), null);
});

test('terminalLabel', () => {
  assert.equal(terminalLabel({ login: '10451501', server: 'MavenTrade-Server', company: 'Maven Trading', name: '2SO P1' }), 'Maven Trading 10451501 · 2SO P1');
  assert.equal(terminalLabel({ login: '42', server: 'X-Live' }), 'X-Live 42');
});
