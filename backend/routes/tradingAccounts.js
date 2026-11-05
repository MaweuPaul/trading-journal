const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const auth = require('../middleware/auth');
const TradingAccount = require('../models/TradingAccount');
const Trade = require('../models/Trade');
const { encryptCredential, decryptCredential } = require('../lib/credentialEncryption');
const { findAccountFor, terminalLabel } = require('../lib/terminalAccounts');

const router = express.Router();

function ownerOnly(req, res, next) {
  if (req.user.role === 'sync_agent') return res.status(403).json({ error: 'Owner session required.' });
  next();
}

function credentialContext(userId, accountId, field) {
  return `${userId}:${accountId}:${field}`;
}

function encryptFields(userId, accountId, values) {
  return Object.fromEntries(['login', 'password', 'server'].map(field => [
    field,
    encryptCredential(values[field], credentialContext(userId, accountId, field)),
  ]));
}

function publicAccount(account, tradeCount = 0) {
  return {
    id: String(account._id),
    accountKey: account.accountKey,
    provider: account.provider,
    label: account.label,
    enabled: account.enabled,
    archived: Boolean(account.archivedAt),
    requireRealAccount: account.requireRealAccount,
    symbolAliases: account.symbolAliases || '',
    lastStatus: account.enabled ? account.lastStatus : 'disabled',
    lastError: account.lastError || '',
    lastConnectedAt: account.lastConnectedAt,
    lastSyncAt: account.lastSyncAt,
    lastAgentSeenAt: account.lastAgentSeenAt,
    lastBalance: account.lastBalance,
    actualAccountType: account.actualAccountType || '',
    tradeCount,
    hasCredentials: account.provider === 'mt5',
    statementLogin: account.statementLogin || '',
    statementServer: account.statementServer || '',
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    investor: {
      enabled: Boolean(account.investor?.enabled),
      code: account.investor?.enabled ? account.investor.code : null,
      lastViewedAt: account.investor?.lastViewedAt || null,
    },
  };
}

function randomInvestorCode() {
  // Digits only, styled like a broker account number -- easy to read back
  // over a phone call the way an MT5 investor login would be.
  return String(crypto.randomInt(10 ** 7, 10 ** 8));
}

function randomInvestorPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, c => ({ '+': '8', '/': '9', '=': '' }[c]));
}

function validateInput(body, creating = false) {
  const label = String(body.label || '').trim();
  const login = String(body.login || '').trim();
  const password = String(body.password || '');
  const server = String(body.server || '').trim();
  if (!label || label.length > 80) return 'Enter an account label of 80 characters or fewer.';
  if (creating && (!login || !server)) return 'Login and broker server are required.';
  if (login && !/^\d{3,20}$/.test(login)) return 'MT5 login must contain 3 to 20 digits.';
  if (password && password.length > 200) return 'MT5 password is too long.';
  if (server && server.length > 160) return 'Broker server is too long.';
  return '';
}

router.get('/trading-accounts', auth, ownerOnly, async (req, res) => {
  try {
    const accounts = await TradingAccount.find({ user: req.user.userId, archivedAt: null }).sort({ createdAt: 1 }).lean();
    const counts = await Trade.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(req.user.userId) } },
      { $group: { _id: '$accountKey', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map(item => [item._id, item.count]));
    res.json({ accounts: accounts.map(account => publicAccount(account, countMap.get(account.accountKey) || 0)) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// The journal's MT5 account for a login and server, however it got here.
async function findMt5Account(userId, login, server) {
  const candidates = await TradingAccount.find({ user: userId, archivedAt: null, provider: { $in: ['mt5', 'mt5_terminal', 'mt5_import'] } }).sort({ createdAt: 1 });
  const credentialOf = account => {
    try {
      const context = field => credentialContext(userId, account._id, field);
      return { login: decryptCredential(account.credentials.login, context('login')), server: decryptCredential(account.credentials.server, context('server')) };
    } catch { return null; }
  };
  return findAccountFor(candidates, login, server, credentialOf);
}

// No password: the Sync App reads this account from an MT5 it's logged in to.
router.post('/trading-accounts', auth, ownerOnly, async (req, res) => {
  try {
    const validationError = validateInput(req.body, true);
    if (validationError) return res.status(400).json({ error: validationError });
    const accountId = new mongoose.Types.ObjectId();
    const userId = String(req.user.userId);
    const login = String(req.body.login).trim();
    const server = String(req.body.server).trim();
    if (await findMt5Account(userId, login, server)) return res.status(409).json({ error: 'This MT5 account is already in your journal.' });
    const account = await TradingAccount.create({
      _id: accountId,
      user: userId,
      accountKey: `mt5:${accountId}`,
      provider: 'mt5_terminal',
      label: String(req.body.label).trim(),
      statementLogin: login,
      statementServer: server,
      enabled: req.body.enabled !== false,
      requireRealAccount: Boolean(req.body.requireRealAccount),
      symbolAliases: String(req.body.symbolAliases || '').trim(),
      lastStatus: 'pending',
    });
    res.status(201).json({ account: publicAccount(account) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/trading-accounts/:id', auth, ownerOnly, async (req, res) => {
  try {
    const account = await TradingAccount.findOne({ _id: req.params.id, user: req.user.userId, archivedAt: null });
    if (!account) return res.status(404).json({ error: 'Trading account not found.' });
    const validationError = validateInput({ ...req.body, label: req.body.label ?? account.label }, false);
    if (validationError) return res.status(400).json({ error: validationError });
    if (req.body.label !== undefined) account.label = String(req.body.label).trim();
    if (req.body.enabled !== undefined) account.enabled = Boolean(req.body.enabled);
    if (req.body.requireRealAccount !== undefined) account.requireRealAccount = Boolean(req.body.requireRealAccount);
    if (req.body.symbolAliases !== undefined) account.symbolAliases = String(req.body.symbolAliases || '').trim();
    for (const field of ['login', 'password', 'server']) {
      if (req.body[field]) {
        account.credentials[field] = encryptCredential(
          req.body[field],
          credentialContext(req.user.userId, account._id, field),
        );
      }
    }
    if (['login', 'password', 'server'].some(field => req.body[field])) {
      account.lastStatus = 'pending';
      account.lastError = '';
    }
    if (!account.enabled) account.lastStatus = 'disabled';
    else if (account.lastStatus === 'disabled') account.lastStatus = 'pending';
    await account.save();
    res.json({ account: publicAccount(account) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/trading-accounts/:id', auth, ownerOnly, async (req, res) => {
  try {
    const account = await TradingAccount.findOne({ _id: req.params.id, user: req.user.userId, archivedAt: null });
    if (!account) return res.status(404).json({ error: 'Trading account not found.' });
    account.enabled = false;
    account.archivedAt = new Date();
    account.lastStatus = 'disabled';
    await account.save();
    res.json({ archived: true, accountId: String(account._id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /trading-accounts/:id/investor-access -- turns on read-only investor
// viewing for this account, or rotates the password if it's already on. The
// investor's account number (code) stays stable across rotations so a saved
// bookmark keeps working; only the password changes. The plaintext password
// is only ever returned here, once -- like an MT5 investor password, it
// can't be recovered afterward, only rotated again.
router.post('/trading-accounts/:id/investor-access', auth, ownerOnly, async (req, res) => {
  try {
    const account = await TradingAccount.findOne({ _id: req.params.id, user: req.user.userId, archivedAt: null });
    if (!account) return res.status(404).json({ error: 'Trading account not found.' });

    const password = randomInvestorPassword();
    account.investor = {
      enabled: true,
      code: account.investor?.code || randomInvestorCode(),
      passwordHash: await bcrypt.hash(password, 10),
      createdAt: account.investor?.createdAt || new Date(),
      lastViewedAt: account.investor?.lastViewedAt || null,
    };
    await account.save();
    res.json({ code: account.investor.code, password });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /trading-accounts/:id/investor-access -- revokes it outright. The
// code is cleared too, not just the password, so a stale bookmarked login
// page can't even identify the account, let alone get a password prompt.
// investor.code must be $unset (made genuinely absent), not set to null --
// the sparse unique index on it only exempts a missing field, and an
// explicit null on two different revoked accounts collides as a duplicate.
router.delete('/trading-accounts/:id/investor-access', auth, ownerOnly, async (req, res) => {
  try {
    const account = await TradingAccount.findOneAndUpdate(
      { _id: req.params.id, user: req.user.userId, archivedAt: null },
      { $set: { 'investor.enabled': false, 'investor.passwordHash': null, 'investor.createdAt': null, 'investor.lastViewedAt': null }, $unset: { 'investor.code': '' } },
      { new: true },
    );
    if (!account) return res.status(404).json({ error: 'Trading account not found.' });
    res.json({ revoked: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/sync-agent/trading-accounts', auth, async (req, res) => {
  try {
    if (req.user.role !== 'sync_agent') return res.status(403).json({ error: 'Sync agent token required.' });
    // This endpoint only serves the local MT5 sync agent -- cTrader accounts
    // are OAuth-connected and synced server-side (see routes/ctrader.js), so
    // they carry no MT5 login/password/server to decrypt here.
    const accounts = await TradingAccount.find({ user: req.user.userId, archivedAt: null, enabled: true, provider: 'mt5' }).sort({ createdAt: 1 });
    const values = accounts.map(account => {
      const context = field => credentialContext(req.user.userId, account._id, field);
      return {
        id: String(account._id),
        accountKey: account.accountKey,
        label: account.label,
        login: decryptCredential(account.credentials.login, context('login')),
        password: decryptCredential(account.credentials.password, context('password')),
        server: decryptCredential(account.credentials.server, context('server')),
        requireRealAccount: account.requireRealAccount,
        symbolAliases: account.symbolAliases || '',
      };
    });
    await TradingAccount.updateMany({ _id: { $in: accounts.map(account => account._id) } }, { $set: { lastAgentSeenAt: new Date() } });
    res.json({ accounts: values });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sync-agent/trading-accounts/discover  { login, server, company, name, accountType }
// The agent found an MT5 terminal logged into this account. Returns the
// journal's record for it (added with a password, imported from a
// statement, or found before), or creates one -- no password: the agent
// reads the open terminal and never logs in.
router.post('/sync-agent/trading-accounts/discover', auth, async (req, res) => {
  try {
    if (req.user.role !== 'sync_agent') return res.status(403).json({ error: 'Sync agent token required.' });
    const login = String(req.body.login || '').trim();
    const server = String(req.body.server || '').trim().slice(0, 160);
    if (!/^\d{1,20}$/.test(login) || !server) return res.status(400).json({ error: 'login and server are required.' });

    const userId = String(req.user.userId);
    let account = await findMt5Account(userId, login, server);
    if (!account) {
      const accountId = new mongoose.Types.ObjectId();
      account = await TradingAccount.create({
        _id: accountId, user: userId, accountKey: `mt5:${accountId}`, provider: 'mt5_terminal',
        label: terminalLabel({ login, server, company: req.body.company, name: req.body.name }),
        statementLogin: login, statementServer: server,
        enabled: true, lastStatus: 'pending',
        actualAccountType: ['live', 'demo'].includes(req.body.accountType) ? req.body.accountType : '',
      });
    } else if (account.provider === 'mt5_import') {
      // A statement-imported account now open in a terminal: it syncs live from here on.
      account.provider = 'mt5_terminal';
      await account.save();
    }
    res.json({
      account: {
        id: String(account._id), accountKey: account.accountKey, label: account.label, provider: account.provider,
        enabled: account.enabled, requireRealAccount: account.requireRealAccount, symbolAliases: account.symbolAliases || '',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/sync-agent/trading-accounts/import-legacy', auth, async (req, res) => {
  try {
    if (req.user.role !== 'sync_agent') return res.status(403).json({ error: 'Sync agent token required.' });
    if (await TradingAccount.exists({ user: req.user.userId, archivedAt: null })) {
      return res.status(409).json({ error: 'A database-managed trading account already exists.' });
    }
    const validationError = validateInput(req.body, true);
    if (validationError) return res.status(400).json({ error: validationError });
    const accountId = new mongoose.Types.ObjectId();
    const userId = String(req.user.userId);
    const account = await TradingAccount.create({
      _id: accountId,
      user: userId,
      accountKey: `mt5:${accountId}`,
      provider: 'mt5',
      label: String(req.body.label).trim(),
      credentials: encryptFields(userId, accountId, req.body),
      enabled: true,
      requireRealAccount: Boolean(req.body.requireRealAccount),
      symbolAliases: String(req.body.symbolAliases || '').trim(),
      lastStatus: 'pending',
    });
    res.status(201).json({ account: publicAccount(account), imported: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/sync-agent/trading-accounts/:id/status', auth, async (req, res) => {
  try {
    if (req.user.role !== 'sync_agent') return res.status(403).json({ error: 'Sync agent token required.' });
    const status = ['connected', 'error'].includes(req.body.status) ? req.body.status : 'error';
    const update = {
      lastStatus: status,
      lastError: status === 'error' ? String(req.body.error || 'Connection failed').slice(0, 500) : '',
      lastAgentSeenAt: new Date(),
    };
    if (status === 'connected') {
      update.lastConnectedAt = new Date();
      if (req.body.synced) update.lastSyncAt = new Date();
      if (Number.isFinite(Number(req.body.balance))) update.lastBalance = Number(req.body.balance);
      if (['live', 'demo'].includes(req.body.accountType)) update.actualAccountType = req.body.accountType;
    }
    const account = await TradingAccount.findOneAndUpdate(
      { _id: req.params.id, user: req.user.userId, archivedAt: null },
      { $set: update },
      { new: true },
    );
    if (!account) return res.status(404).json({ error: 'Trading account not found.' });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
