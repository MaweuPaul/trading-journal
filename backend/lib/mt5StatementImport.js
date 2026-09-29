// Imports an uploaded MT5 report into the journal: finds (or creates) the
// account it belongs to, adds positions and deposits/withdrawals the journal
// doesn't have yet, and leaves everything already there untouched. A preview
// (commit: false) does the same matching and only counts.
const mongoose = require('mongoose');
const Trade = require('../models/Trade');
const AccountEvent = require('../models/AccountEvent');
const TradingAccount = require('../models/TradingAccount');
const { decryptCredential } = require('./credentialEncryption');
const { parseMt5Statement, statementTrades } = require('./mt5Statement');

const MAX_CONTENT = 20_000_000;
const lc = value => String(value || '').trim().toLowerCase();

/** Journal accounts the report could belong to: an earlier import of the same login, or a synced MT5 account with it. */
async function matchAccount(userId, account) {
  if (!account) return null;
  const accounts = await TradingAccount.find({ user: userId, archivedAt: null }).lean();
  const imported = accounts.find(a => a.provider === 'mt5_import' && a.statementLogin === account.login
    && (!account.server || !a.statementServer || lc(a.statementServer) === lc(account.server)));
  if (imported) return imported;
  for (const a of accounts.filter(item => item.provider === 'mt5' && item.credentials?.login)) {
    try {
      const login = decryptCredential(a.credentials.login, `${userId}:${a._id}:login`);
      const server = a.credentials.server ? decryptCredential(a.credentials.server, `${userId}:${a._id}:server`) : '';
      if (String(login) === account.login && (!account.server || !server || lc(server) === lc(account.server))) return a;
    } catch { /* a credential we can't read: not a match */ }
  }
  return null;
}

const publicTarget = a => (a ? { id: String(a._id), label: a.label, provider: a.provider } : null);

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.content  the report's text (HTML)
 * @param {string} [opts.target] 'auto' (default), 'new', or a TradingAccount id
 * @param {boolean} [opts.commit] false = preview only
 * @param {Array} [opts.checklist] / [opts.executionChecklist] rule snapshots for new trades
 */
async function importMt5Statement({ userId, content, target = 'auto', commit = false, checklist = [], executionChecklist = [] }) {
  if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('Choose the report file first.'), { status: 400 });
  if (content.length > MAX_CONTENT) throw Object.assign(new Error('That report is too large (over 20 MB). Save a shorter period in MT5 and import it in parts.'), { status: 400 });
  let parsed;
  try { parsed = parseMt5Statement(content); } catch (err) { throw Object.assign(err, { status: 400 }); }
  const trades = statementTrades(parsed);
  if (!trades.length && !parsed.balanceOps.length) {
    throw Object.assign(new Error('No closed positions in this report. In MT5 pick a longer period in History (right-click → Custom Period) before saving the report.'), { status: 400 });
  }

  const matched = await matchAccount(userId, parsed.account);
  let account = null;
  if (target && target !== 'auto' && target !== 'new') {
    if (!mongoose.Types.ObjectId.isValid(String(target))) throw Object.assign(new Error('Unknown account.'), { status: 400 });
    account = await TradingAccount.findOne({ _id: target, user: userId, archivedAt: null }).lean();
    if (!account) throw Object.assign(new Error('That account no longer exists.'), { status: 404 });
    if (account.provider === 'ctrader') throw Object.assign(new Error('Pick an MT5 account: cTrader accounts sync on their own.'), { status: 400 });
  } else if (target !== 'new') {
    account = matched;
  }

  // What's already in the journal for this account.
  const accountKey = account ? lc(account.accountKey) : '';
  const existing = accountKey ? await Trade.find({ user: userId, accountKey }).select('dealId positionId').lean() : [];
  const knownPositions = new Set(existing.map(t => t.positionId).filter(Boolean));
  const knownDeals = new Set(existing.map(t => t.dealId));
  const fresh = trades.filter(t => !knownPositions.has(t.positionId) && !knownDeals.has(t.dealId));
  const knownEvents = accountKey
    ? new Set((await AccountEvent.find({ user: userId, accountKey }).select('externalId').lean()).map(e => e.externalId))
    : new Set();
  const freshEvents = parsed.balanceOps.filter(e => !knownEvents.has(e.externalId));

  const times = trades.map(t => t.closeTime.getTime());
  const summary = {
    account: parsed.account ? { ...parsed.account, name: parsed.name, company: parsed.company } : null,
    period: times.length ? { from: new Date(Math.min(...times)), to: new Date(Math.max(...times)) } : null,
    positions: trades.length,
    newTrades: fresh.length,
    alreadyInJournal: trades.length - fresh.length,
    cashMovements: parsed.balanceOps.length,
    newCashMovements: freshEvents.length,
    matchedAccount: publicTarget(matched),
    target: account ? publicTarget(account) : { id: 'new', label: newAccountLabel(parsed.account), provider: 'mt5_import' },
  };
  if (!commit) return summary;

  if (!account) {
    const id = new mongoose.Types.ObjectId();
    account = (await TradingAccount.create({
      _id: id, user: userId, provider: 'mt5_import', accountKey: `mt5import:${id}`,
      label: newAccountLabel(parsed.account),
      statementLogin: parsed.account?.login || '', statementServer: parsed.account?.server || '',
      enabled: true, lastStatus: 'connected', actualAccountType: parsed.account?.accountType || '',
    })).toObject();
  }
  const identity = {
    accountKey: lc(account.accountKey),
    accountName: account.label,
    accountType: parsed.account?.accountType || account.actualAccountType || '',
    accountLogin: parsed.account?.login || '',
    accountServer: parsed.account?.server || '',
    tradingAccount: account._id,
  };

  let inserted = 0;
  for (const t of fresh) {
    try {
      await Trade.create({
        ...t,
        ...identity,
        importSource: 'mt5-statement',
        checklist: checklist.map(rule => ({ ...rule })),
        executionChecklist: executionChecklist.map(rule => ({ ...rule })),
        user: userId,
        synced: new Date(),
      });
      inserted++;
    } catch (err) {
      if (err?.code !== 11000) throw err; // already there (e.g. two imports at once)
    }
  }
  let eventsInserted = 0;
  for (const e of freshEvents) {
    try {
      await AccountEvent.create({
        ...e, currency: parsed.account?.currency || 'USD', source: 'mt5',
        accountKey: identity.accountKey, tradingAccount: account._id, user: userId,
      });
      eventsInserted++;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }

  const lastBalance = [...parsed.deals].reverse().find(d => Number.isFinite(d.balance))?.balance;
  await TradingAccount.updateOne({ _id: account._id, user: userId }, {
    $set: {
      lastSyncAt: new Date(),
      ...(account.provider === 'mt5_import' ? { lastStatus: 'connected', lastError: '' } : {}),
      ...(Number.isFinite(lastBalance) && account.provider === 'mt5_import' ? { lastBalance } : {}),
      ...(identity.accountType && !account.actualAccountType ? { actualAccountType: identity.accountType } : {}),
    },
  });
  return { ...summary, target: publicTarget(account), inserted, eventsInserted };
}

function newAccountLabel(account) {
  if (!account) return 'MT5 (imported)';
  return `MT5 ${account.login}${account.server ? ` · ${account.server}` : ''}`.slice(0, 80);
}

module.exports = { importMt5Statement, matchAccount };
