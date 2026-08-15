const mongoose = require('mongoose');
const CTraderConnection = require('../models/CTraderConnection');
const { decryptCredential, encryptCredential } = require('./credentialEncryption');
const { refreshAccessToken } = require('./ctraderAuth');
const { CTraderClient, PAYLOAD_TYPE } = require('./ctraderClient');

const LIVE_HOST = 'live.ctraderapi.com';
const DEMO_HOST = 'demo.ctraderapi.com';

const PERIOD_BY_LABEL = {
  '1min': 1,  // M1
  '5min': 5,  // M5
  '15min': 7, // M15
  '1h': 9,    // H1
  '4h': 10,   // H4
  '1day': 12, // D1
};

function tokenContext(userId, field) {
  return `ctrader:${userId}:${field}`;
}

// One authenticated connection per ctidTraderAccountId, reused across
// replay requests instead of reconnecting (ApplicationAuth + AccountAuth)
// every time the owner opens a different trade's Replay panel.
const connectionCache = new Map(); // ctidTraderAccountId -> { client, applicationAuthed, accountAuthedFor }
const symbolCache = new Map(); // ctidTraderAccountId -> { fetchedAt, bySymbolName: Map }
const SYMBOL_CACHE_TTL_MS = 60 * 60 * 1000; // symbol lists change rarely

async function connectApplicationOnly(isLive) {
  const client = new CTraderClient({ host: isLive ? LIVE_HOST : DEMO_HOST });
  await client.connect();
  await client.request(PAYLOAD_TYPE.APPLICATION_AUTH_REQ, {
    clientId: requireEnv('CTRADER_CLIENT_ID'),
    clientSecret: requireEnv('CTRADER_CLIENT_SECRET'),
  });
  return client;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured on the backend`);
  return value;
}

// Fetch the trading accounts an access token grants access to. Used right
// after OAuth exchange to let the owner pick which cTrader account to pull
// Replay candles from — this only needs ApplicationAuth, not AccountAuth.
async function fetchAccountList(accessToken) {
  // isLive is unknown yet at this point, so try demo first (cTrader allows
  // this call from either host) and fall back to live on failure.
  let client;
  try {
    client = await connectApplicationOnly(false);
  } catch (_e) {
    client = await connectApplicationOnly(true);
  }
  try {
    const res = await client.request(PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, { accessToken });
    return (res.ctidTraderAccount || []).map(a => ({
      ctidTraderAccountId: a.ctidTraderAccountId,
      isLive: Boolean(a.isLive),
      brokerTitle: a.brokerTitleShort || '',
      traderLogin: a.traderLogin,
    }));
  } finally {
    client.close();
  }
}

async function loadConnection(userId) {
  // CTraderConnection is Mongo-only (encrypted OAuth tokens need a durable
  // store), and the offline-login sentinel ID isn't a valid ObjectId — both
  // would otherwise surface as a raw Mongoose CastError instead of a clear
  // "cTrader needs MongoDB" message.
  if (mongoose.connection.readyState !== 1) {
    const err = new Error('cTrader requires MongoDB to be connected. Replay is unavailable in offline mode.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const connection = await CTraderConnection.findOne({ user: userId });
  if (!connection) return null;
  if (!connection.ctidTraderAccountId) {
    const err = new Error('cTrader is connected but no trading account has been selected yet. Finish setup on the Accounts page.');
    err.code = 'NO_ACCOUNT_SELECTED';
    throw err;
  }

  let accessToken = decryptCredential(connection.accessToken, tokenContext(String(userId), 'accessToken'));

  // Refresh proactively if the token is expired or close to it.
  if (connection.expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    const refreshToken = decryptCredential(connection.refreshToken, tokenContext(String(userId), 'refreshToken'));
    const refreshed = await refreshAccessToken(refreshToken);
    accessToken = refreshed.accessToken;
    connection.accessToken = encryptCredential(refreshed.accessToken, tokenContext(String(userId), 'accessToken'));
    connection.refreshToken = encryptCredential(refreshed.refreshToken || refreshToken, tokenContext(String(userId), 'refreshToken'));
    connection.expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
    await connection.save();
  }

  return { accessToken, ctidTraderAccountId: connection.ctidTraderAccountId, isLive: connection.isLive };
}

async function getAuthenticatedClient({ accessToken, ctidTraderAccountId, isLive }) {
  const cached = connectionCache.get(ctidTraderAccountId);
  if (cached && cached.client.socket) return cached.client;

  const client = new CTraderClient({ host: isLive ? LIVE_HOST : DEMO_HOST });
  await client.connect();
  await client.request(PAYLOAD_TYPE.APPLICATION_AUTH_REQ, {
    clientId: requireEnv('CTRADER_CLIENT_ID'),
    clientSecret: requireEnv('CTRADER_CLIENT_SECRET'),
  });
  await client.request(PAYLOAD_TYPE.ACCOUNT_AUTH_REQ, {
    ctidTraderAccountId: Number(ctidTraderAccountId),
    accessToken,
  });

  const originalClose = client.close.bind(client);
  client.close = () => { connectionCache.delete(ctidTraderAccountId); originalClose(); };

  connectionCache.set(ctidTraderAccountId, { client });
  return client;
}

async function resolveSymbolId(client, ctidTraderAccountId, symbolName) {
  let cache = symbolCache.get(ctidTraderAccountId);
  if (!cache || Date.now() - cache.fetchedAt > SYMBOL_CACHE_TTL_MS) {
    const res = await client.request(PAYLOAD_TYPE.SYMBOLS_LIST_REQ, {
      ctidTraderAccountId: Number(ctidTraderAccountId),
      includeArchivedSymbols: false,
    });
    const bySymbolName = new Map();
    for (const symbol of res.symbol || []) {
      bySymbolName.set(String(symbol.symbolName || '').toUpperCase(), symbol.symbolId);
    }
    cache = { fetchedAt: Date.now(), bySymbolName };
    symbolCache.set(ctidTraderAccountId, cache);
  }

  const normalized = normalizeSymbolForCTrader(symbolName);
  if (cache.bySymbolName.has(normalized)) return cache.bySymbolName.get(normalized);

  // Try a fuzzy match: brokers append suffixes like 'm', '.a', '_i' to MT5
  // symbol names, and cTrader's own naming can differ slightly (e.g. slashes).
  const strippedTarget = normalized.replace(/[^A-Z0-9]/g, '');
  for (const [name, id] of cache.bySymbolName) {
    if (name.replace(/[^A-Z0-9]/g, '') === strippedTarget) return id;
  }
  return null;
}

// MT5 broker symbols often carry suffixes ('XAUUSDm', 'EURUSD.a') or use
// different separators than cTrader's own symbol names ('EUR/USD' vs 'EURUSD').
function normalizeSymbolForCTrader(raw) {
  return String(raw || '').toUpperCase().trim().replace(/[mn+\.]+$/i, '');
}

// The core Replay data call: historical candles for one symbol/window from
// the owner's connected cTrader account.
async function getTrendbars({ userId, symbol, periodLabel, fromMs, toMs }) {
  const period = PERIOD_BY_LABEL[periodLabel];
  if (!period) throw new Error(`Unsupported replay interval: ${periodLabel}`);

  const connectionInfo = await loadConnection(userId);
  if (!connectionInfo) {
    const err = new Error('cTrader is not connected. Connect it on the Accounts page to use Trade Replay.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const client = await getAuthenticatedClient(connectionInfo);
  const symbolId = await resolveSymbolId(client, connectionInfo.ctidTraderAccountId, symbol);
  if (symbolId == null) {
    const err = new Error(`cTrader does not have a symbol matching "${symbol}" on this account.`);
    err.code = 'SYMBOL_NOT_FOUND';
    throw err;
  }

  const res = await client.request(PAYLOAD_TYPE.GET_TRENDBARS_REQ, {
    ctidTraderAccountId: Number(connectionInfo.ctidTraderAccountId),
    fromTimestamp: Math.floor(fromMs),
    toTimestamp: Math.floor(toMs),
    period,
    symbolId,
    count: 1500,
  });

  // Prices are transmitted as 1/100000ths of a unit, and open/high/close are
  // deltas above the bar's low (see OpenApiModelMessages.proto ProtoOATrendbar).
  const candles = (res.trendbar || [])
    .map(bar => {
      const low = Number(bar.low) / 100000;
      return {
        time: Number(bar.utcTimestampInMinutes) * 60,
        open: low + Number(bar.deltaOpen || 0) / 100000,
        high: low + Number(bar.deltaHigh || 0) / 100000,
        low,
        close: low + Number(bar.deltaClose || 0) / 100000,
      };
    })
    .sort((a, b) => a.time - b.time);

  return { candles, source: 'ctrader', sourceLabel: 'cTrader', brokerSymbol: symbol };
}

module.exports = { fetchAccountList, getTrendbars };
