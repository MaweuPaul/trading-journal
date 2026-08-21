const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const CTraderConnection = require('../models/CTraderConnection');
const { encryptCredential, decryptCredential } = require('../lib/credentialEncryption');
const { buildAuthorizationUrl, exchangeCodeForToken, refreshAccessToken } = require('../lib/ctraderAuth');
const { fetchAccountList } = require('../lib/ctraderReplay');
const { syncCTraderTrades } = require('../lib/ctraderSync');

const router = express.Router();

function ownerOnly(req, res, next) {
  if (req.user.role === 'sync_agent') return res.status(403).json({ error: 'Owner session required.' });
  next();
}

function tokenContext(userId, field) {
  return `ctrader:${userId}:${field}`;
}

function publicConnection(connection) {
  return {
    ctidTraderAccountId: connection.ctidTraderAccountId,
    isLive: connection.isLive,
    brokerTitle: connection.brokerTitle,
    traderLogin: connection.traderLogin,
    connectedAt: connection.connectedAt,
  };
}

// GET /api/ctrader/status -- every finalized cTrader connection for this
// owner (an owner can have several, even under different cTrader logins).
router.get('/ctrader/status', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json({ connections: [], databaseAvailable: false });
    }
    const connections = await CTraderConnection
      .find({ user: req.user.userId, ctidTraderAccountId: { $ne: '' } })
      .sort({ connectedAt: 1 })
      .lean();
    res.json({ connections: connections.map(publicConnection), databaseAvailable: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/ctrader/auth-url', auth, ownerOnly, (req, res) => {
  try {
    res.json({ url: buildAuthorizationUrl() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ctrader/exchange  { code }  -- completes one OAuth authorization
// and stashes the resulting token as a "pending" connection (ctidTraderAccountId
// ''), since we no longer know yet which of the reachable accounts the owner
// wants. Always returns the full account list, even when it's just one --
// supporting several cTrader logins means we can't silently auto-pick anymore.
router.post('/ctrader/exchange', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'The database must be connected to store the cTrader connection.' });
    }
    const code = String(req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing authorization code.' });

    const tokens = await exchangeCodeForToken(code);
    if (!tokens.accessToken || !tokens.refreshToken) {
      return res.status(502).json({ error: 'cTrader did not return an access/refresh token pair.' });
    }

    const accounts = await fetchAccountList(tokens.accessToken);
    const userId = String(req.user.userId);

    // Only one pending flow at a time -- clear out anything left over from
    // an authorization the owner started but never finished.
    await CTraderConnection.deleteMany({ user: userId, ctidTraderAccountId: '' });
    await CTraderConnection.create({
      user: userId,
      accessToken: encryptCredential(tokens.accessToken, tokenContext(userId, 'accessToken')),
      refreshToken: encryptCredential(tokens.refreshToken, tokenContext(userId, 'refreshToken')),
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      ctidTraderAccountId: '',
      connectedAt: new Date(),
    });

    const existing = await CTraderConnection
      .find({ user: userId, ctidTraderAccountId: { $ne: '' } })
      .select('ctidTraderAccountId')
      .lean();
    const alreadyConnected = new Set(existing.map(c => c.ctidTraderAccountId));

    res.json({
      accounts: accounts.map(a => ({
        ctidTraderAccountId: String(a.ctidTraderAccountId),
        isLive: a.isLive,
        brokerTitle: a.brokerTitle || '',
        traderLogin: String(a.traderLogin || ''),
        alreadyConnected: alreadyConnected.has(String(a.ctidTraderAccountId)),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ctrader/select-accounts  { ctidTraderAccountIds: string[] }
// Finalizes the pending connection into one row per chosen account, all
// sharing the OAuth token pair that was just authorized.
router.post('/ctrader/select-accounts', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'The database must be connected.' });
    }
    const requestedIds = Array.isArray(req.body.ctidTraderAccountIds)
      ? [...new Set(req.body.ctidTraderAccountIds.map(String).filter(Boolean))]
      : [];
    if (requestedIds.length === 0) return res.status(400).json({ error: 'Choose at least one account.' });

    const userId = String(req.user.userId);
    const pending = await CTraderConnection.findOne({ user: userId, ctidTraderAccountId: '' });
    if (!pending) return res.status(400).json({ error: 'No pending cTrader authorization found. Start over from "Connect cTrader".' });

    const accessToken = decryptCredential(pending.accessToken, tokenContext(userId, 'accessToken'));
    const availableAccounts = await fetchAccountList(accessToken);
    const availableById = new Map(availableAccounts.map(a => [String(a.ctidTraderAccountId), a]));

    const invalidId = requestedIds.find(id => !availableById.has(id));
    if (invalidId) return res.status(400).json({ error: `Account ${invalidId} isn't reachable with this authorization.` });

    for (const id of requestedIds) {
      const account = availableById.get(id);
      await CTraderConnection.findOneAndUpdate(
        { user: userId, ctidTraderAccountId: id },
        {
          $set: {
            accessToken: pending.accessToken,
            refreshToken: pending.refreshToken,
            expiresAt: pending.expiresAt,
            isLive: Boolean(account.isLive),
            brokerTitle: account.brokerTitle || '',
            traderLogin: String(account.traderLogin || ''),
            connectedAt: new Date(),
          },
          $setOnInsert: { user: userId, ctidTraderAccountId: id },
        },
        { upsert: true, new: true },
      );
    }
    await CTraderConnection.deleteOne({ _id: pending._id });

    const connections = await CTraderConnection
      .find({ user: userId, ctidTraderAccountId: { $ne: '' } })
      .sort({ connectedAt: 1 });
    res.json({ connections: connections.map(publicConnection) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/ctrader/connection/:ctidTraderAccountId -- disconnects one
// specific account without touching the owner's other cTrader connections.
router.delete('/ctrader/connection/:ctidTraderAccountId', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'The database must be connected.' });
    }
    await CTraderConnection.deleteOne({ user: req.user.userId, ctidTraderAccountId: req.params.ctidTraderAccountId });
    res.json({ disconnected: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ctrader/sync[/:ctidTraderAccountId]  -- pulls deal history + cash
// flow since the last sync and folds it into Trade/AccountEvent, same as an
// MT5 sync would. Triggered by the owner clicking "Sync Now"; there's no
// local agent for cTrader since it's a cloud API reachable directly from the
// backend. With no account id, syncs every connected cTrader account.
async function handleSync(req, res) {
  try {
    const result = await syncCTraderTrades(req.user.userId, req.params.ctidTraderAccountId);
    res.json(result);
  } catch (error) {
    const status = ['NOT_CONNECTED', 'DISABLED'].includes(error.code) ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
}
router.post('/ctrader/sync', auth, ownerOnly, handleSync);
router.post('/ctrader/sync/:ctidTraderAccountId', auth, ownerOnly, handleSync);

module.exports = router;
