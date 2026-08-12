function cleanAccountField(value, maxLength = 120) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeAccountIdentity(source = {}) {
  const accountLogin = cleanAccountField(source.accountLogin, 40);
  const accountServer = cleanAccountField(source.accountServer, 120);
  const accountName = cleanAccountField(source.accountName, 120);
  const suppliedKey = cleanAccountField(source.accountKey, 180).toLowerCase();
  const accountKey = suppliedKey || (accountLogin ? `${accountServer.toLowerCase()}::${accountLogin}` : '');
  const accountType = ['live', 'demo'].includes(String(source.accountType).toLowerCase())
    ? String(source.accountType).toLowerCase()
    : '';
  return { accountKey, accountLogin, accountServer, accountName, accountType };
}

function accountOptionFromTrade(trade) {
  const identity = normalizeAccountIdentity(trade);
  if (!identity.accountKey) return null;
  const primary = identity.accountName || `MT5 ${identity.accountLogin}`;
  const detail = [identity.accountLogin, identity.accountServer].filter(Boolean).join(' · ');
  return { ...identity, label: detail ? `${primary} — ${detail}` : primary };
}

function summarizeTradeAccounts(trades) {
  const accounts = new Map();
  let unassignedCount = 0;
  for (const trade of trades) {
    const option = accountOptionFromTrade(trade);
    if (!option) {
      unassignedCount++;
      continue;
    }
    const current = accounts.get(option.accountKey);
    accounts.set(option.accountKey, { ...option, count: (current?.count || 0) + 1 });
  }
  return {
    accounts: Array.from(accounts.values()).sort((a, b) => a.label.localeCompare(b.label)),
    unassignedCount,
  };
}

function tradeMatchesAccountFilter(trade, accountKey) {
  const filter = cleanAccountField(accountKey, 180).toLowerCase();
  const tradeKey = cleanAccountField(trade?.accountKey, 180).toLowerCase();
  if (!filter) return true;
  if (filter === '__unassigned__') return !tradeKey;
  return tradeKey === filter;
}

function findTradesMissingAccountIdentity(trades = []) {
  return trades
    .filter(trade => {
      const suppliedKey = cleanAccountField(trade?.accountKey, 180);
      const login = cleanAccountField(trade?.accountLogin, 40);
      const server = cleanAccountField(trade?.accountServer, 120);
      return !suppliedKey && (!login || !server);
    })
    .map(trade => cleanAccountField(trade?.dealId, 80) || '(unknown deal)');
}

module.exports = {
  cleanAccountField,
  normalizeAccountIdentity,
  summarizeTradeAccounts,
  tradeMatchesAccountFilter,
  findTradesMissingAccountIdentity,
};
