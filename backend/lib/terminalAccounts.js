// MT5 accounts the sync agent finds open in a running terminal on the
// trader's computer (one terminal per account, as trade copiers run them).
// The agent reads them where they are, never logging in, so no password is
// stored; this matches one to the journal's existing account record.

const norm = value => String(value || '').trim().toLowerCase();

/**
 * The journal account for MT5 `login` on `server`: one added with its
 * password (`credentialOf` decrypts its login/server, or returns null), one
 * imported from a statement, or one found in a terminal before. A blank
 * server on either side matches any.
 */
function findAccountFor(accounts, login, server, credentialOf) {
  const wantLogin = String(login).trim();
  const wantServer = norm(server);
  const sameServer = s => !norm(s) || !wantServer || norm(s) === wantServer;
  for (const account of accounts) {
    if (account.provider === 'mt5') {
      const credentials = credentialOf(account);
      if (credentials && String(credentials.login).trim() === wantLogin && sameServer(credentials.server)) return account;
    } else if ((account.provider === 'mt5_terminal' || account.provider === 'mt5_import')
      && String(account.statementLogin || '').trim() === wantLogin && sameServer(account.statementServer)) {
      return account;
    }
  }
  return null;
}

/** "Maven Trading 10451501 · 2SO P1" from what the terminal reports. */
function terminalLabel({ login, server, company, name }) {
  const broker = String(company || server || 'MT5').trim();
  const owner = String(name || '').trim();
  return `${broker} ${login}${owner ? ` · ${owner}` : ''}`.slice(0, 80);
}

module.exports = { findAccountFor, terminalLabel };
