const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const CTraderConnection = require('../models/CTraderConnection');
const { encryptCredential } = require('../lib/credentialEncryption');
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
  if (!connection) return null;
  return {
    connected: true,
    ctidTraderAccountId: connection.ctidTraderAccountId,
    isLive: connection.isLive,
    brokerTitle: connection.brokerTitle,
    traderLogin: connection.traderLogin,
    connectedAt: connection.connectedAt,
    hasSelectedAccount: Boolean(connection.ctidTraderAccountId),
  };
}

router.get('/ctrader/status', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json({ connected: false, databaseAvailable: false });
    }
    const connection = await CTraderConnection.findOne({ user: req.user.userId }).lean();
    res.json(connection ? { ...publicConnection(connection), databaseAvailable: true } : { connected: false, databaseAvailable: true });
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

// POST /api/ctrader/exchange  { code }  -- completes the one-time OAuth authorization
router.post('/ctrader/exchange', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'MongoDB must be connected to store the cTrader connection.' });
    }
    const code = String(req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing authorization code.' });

    const tokens = await exchangeCodeForToken(code);
    if (!tokens.accessToken || !tokens.refreshToken) {
      return res.status(502).json({ error: 'cTrader did not return an access/refresh token pair.' });
    }

    const accounts = await fetchAccountList(tokens.accessToken);

    const userId = String(req.user.userId);
    const update = {
      accessToken: encryptCredential(tokens.accessToken, tokenContext(userId, 'accessToken')),
      refreshToken: encryptCredential(tokens.refreshToken, tokenContext(userId, 'refreshToken')),
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      connectedAt: new Date(),
    };
    // Auto-select if the token only grants access to one account; otherwise
    // leave ctidTraderAccountId unset until the owner picks one.
    if (accounts.length === 1) {
      update.ctidTraderAccountId = String(accounts[0].ctidTraderAccountId);
      update.isLive = accounts[0].isLive;
      update.brokerTitle = accounts[0].brokerTitle || '';
      update.traderLogin = String(accounts[0].traderLogin || '');
    }

    const connection = await CTraderConnection.findOneAndUpdate(
      { user: userId },
      { $set: update, $setOnInsert: { user: userId } },
      { upsert: true, new: true },
    );

    res.json({
      connection: publicConnection(connection),
      accounts: accounts.map(a => ({
        ctidTraderAccountId: String(a.ctidTraderAccountId),
        isLive: a.isLive,
        brokerTitle: a.brokerTitle || '',
        traderLogin: String(a.traderLogin || ''),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/ctrader/select-account', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'MongoDB must be connected.' });
    }
    const { ctidTraderAccountId, isLive, brokerTitle, traderLogin } = req.body;
    if (!ctidTraderAccountId) return res.status(400).json({ error: 'ctidTraderAccountId is required.' });

    const connection = await CTraderConnection.findOneAndUpdate(
      { user: req.user.userId },
      { $set: {
        ctidTraderAccountId: String(ctidTraderAccountId),
        isLive: Boolean(isLive),
        brokerTitle: String(brokerTitle || ''),
        traderLogin: String(traderLogin || ''),
      } },
      { new: true },
    );
    if (!connection) return res.status(404).json({ error: 'Connect cTrader first.' });
    res.json({ connection: publicConnection(connection) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/ctrader/connection', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'MongoDB must be connected.' });
    }
    await CTraderConnection.deleteOne({ user: req.user.userId });
    res.json({ disconnected: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ctrader/sync  -- pulls deal history + cash flow since the last
// sync and folds it into Trade/AccountEvent, same as an MT5 sync would.
// Triggered by the owner clicking "Sync Now"; there's no local agent for
// cTrader since it's a cloud API reachable directly from the backend.
router.post('/ctrader/sync', auth, ownerOnly, async (req, res) => {
  try {
    const result = await syncCTraderTrades(req.user.userId);
    res.json(result);
  } catch (error) {
    const status = ['NOT_CONNECTED', 'DISABLED'].includes(error.code) ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});

module.exports = router;
