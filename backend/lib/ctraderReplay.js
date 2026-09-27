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

async function refreshConnectionIfNeeded(connection, userId) {
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
  return {
    accessToken,
    ctidTraderAccountId: connection.ctidTraderAccountId,
    isLive: connection.isLive,
    traderLogin: connection.traderLogin,
    brokerTitle: connection.brokerTitle,
  };
}

// An owner can have several cTrader connections (different accounts, even
// different cTrader logins). `preferredCtidTraderAccountId` lets a caller
// that knows which account a trade actually belongs to ask for that specific
// connection; otherwise this falls back to the earliest-connected one, which
// keeps single-connection callers (most of Replay, today) working unchanged.
async function loadConnection(userId, preferredCtidTraderAccountId) {
  // CTraderConnection is Mongo-only (encrypted OAuth tokens need a durable
  // store), and the offline-login sentinel ID isn't a valid ObjectId — both
  // would otherwise surface as a raw Mongoose CastError instead of a clear
  // "cTrader needs MongoDB" message.
  if (mongoose.connection.readyState !== 1) {
    const err = new Error('cTrader requires MongoDB to be connected. Replay is unavailable in offline mode.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  let connection = null;
  if (preferredCtidTraderAccountId) {
    connection = await CTraderConnection.findOne({ user: userId, ctidTraderAccountId: String(preferredCtidTraderAccountId) });
  }
  if (!connection) {
    connection = await CTraderConnection.findOne({ user: userId, ctidTraderAccountId: { $ne: '' } }).sort({ connectedAt: 1 });
  }
  if (!connection) return null;

  return refreshConnectionIfNeeded(connection, userId);
}

// All of the owner's finalized (account-selected) connections — used to
// sync every connected cTrader account, and to power the Accounts page list.
async function listConnections(userId) {
  if (mongoose.connection.readyState !== 1) {
    const err = new Error('cTrader requires MongoDB to be connected.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  return CTraderConnection.find({ user: userId, ctidTraderAccountId: { $ne: '' } }).sort({ connectedAt: 1 });
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

// Index/metal/energy names diverge a lot between MT5 brokers and cTrader
// brokers — 'USTEC' (Exness) and 'Nasdaq100' (this account's broker) are the
// same instrument with nothing in common textually, so no amount of suffix
// stripping or fuzzy matching bridges that gap. This maps common MT5-side
// names to the cTrader-side names/synonyms worth trying. Forex pairs need no
// entry here — 'EURUSD' is universal enough that direct/stripped matching
// already handles broker suffixes like 'EURUSDm' or 'EURUSD.a'.
const SYMBOL_ALIASES = {
  USTEC: ['NASDAQ100', 'NASDAQCOMP', 'US100', 'USTECH', 'NAS100', 'NDX100', 'NASDAQ', 'NDX', 'USTECHCASH', 'USTECH100', 'TECH100'],
  NAS100: ['NASDAQ100', 'USTEC', 'US100', 'NASDAQCOMP'],
  US100: ['NASDAQ100', 'USTEC', 'NAS100'],
  US30: ['DOW30', 'WALLSTREET30', 'DJ30', 'US30CASH', 'DOWJONES30'],
  DJ30: ['DOW30', 'US30', 'WALLSTREET30'],
  US500: ['SPX500', 'SP500', 'US500CASH', 'SANDP500'],
  SPX500: ['US500', 'SP500', 'SANDP500'],
  SP500: ['SPX500', 'US500'],
  GER40: ['GERMANY40', 'DAX40', 'DE40', 'DAX'],
  GER30: ['GERMANY30', 'DAX30', 'DE30'],
  UK100: ['FTSE100'],
  FRA40: ['FRANCE40', 'CAC40'],
  JPN225: ['JAPAN225', 'NIKKEI225', 'JP225'],
  AUS200: ['AUSTRALIA200', 'ASX200'],
  XAUUSD: ['GOLD'],
  GOLD: ['XAUUSD'],
  XAGUSD: ['SILVER'],
  SILVER: ['XAGUSD'],
  USOIL: ['WTI', 'CRUDEOIL', 'USOILCASH', 'WTICRUDE'],
  UKOIL: ['BRENT', 'UKOILCASH', 'BRENTCRUDE'],
  NATGAS: ['NATURALGAS', 'NGAS'],
  // MT5 brokers (e.g. Exness) spell out crypto CFDs as full words; cTrader
  // brokers use the USD-pair ticker instead.
  BITCOIN: ['BTCUSD', 'BTCUSDT', 'XBTUSD'],
  ETHEREUM: ['ETHUSD', 'ETHUSDT'],
  LITECOIN: ['LTCUSD', 'LTCUSDT'],
  RIPPLE: ['XRPUSD', 'XRPUSDT'],
  BITCOINCASH: ['BCHUSD', 'BCHUSDT'],
  CARDANO: ['ADAUSD', 'ADAUSDT'],
  POLKADOT: ['DOTUSD', 'DOTUSDT'],
  DOGECOIN: ['DOGEUSD', 'DOGEUSDT'],
};

async function getSymbolCache(client, ctidTraderAccountId) {
  let cache = symbolCache.get(ctidTraderAccountId);
  if (!cache || Date.now() - cache.fetchedAt > SYMBOL_CACHE_TTL_MS) {
    const res = await client.request(PAYLOAD_TYPE.SYMBOLS_LIST_REQ, {
      ctidTraderAccountId: Number(ctidTraderAccountId),
      includeArchivedSymbols: false,
    });
    const bySymbolName = new Map();
    const strippedIndex = new Map(); // alnum-only, uppercased -> symbolId
    for (const symbol of res.symbol || []) {
      const name = String(symbol.symbolName || '').toUpperCase();
      bySymbolName.set(name, symbol.symbolId);
      strippedIndex.set(name.replace(/[^A-Z0-9]/g, ''), symbol.symbolId);
    }
    cache = { fetchedAt: Date.now(), bySymbolName, strippedIndex };
    symbolCache.set(ctidTraderAccountId, cache);
  }
  return cache;
}

async function resolveSymbolId(client, ctidTraderAccountId, symbolName) {
  const cache = await getSymbolCache(client, ctidTraderAccountId);

  const tryMatch = candidate => {
    const normalized = normalizeSymbolForCTrader(candidate);
    if (cache.bySymbolName.has(normalized)) return cache.bySymbolName.get(normalized);
    // cTrader's own naming can differ slightly in punctuation (e.g. slashes)
    // from the broker's — compare with everything but letters/digits
    // stripped from both sides.
    const stripped = normalized.replace(/[^A-Z0-9]/g, '');
    if (cache.strippedIndex.has(stripped)) return cache.strippedIndex.get(stripped);
    // Only as a last resort, try peeling off a trailing MT5 account-type
    // suffix ('XAUUSDm', 'EURUSD.a', 'EURUSD+'). Applying this unconditionally
    // would mangle real words that happen to end in 'm'/'n' (e.g. BITCOIN,
    // PLATINUM), so it only kicks in once the exact and punctuation-stripped
    // matches have both failed.
    const suffixStripped = stripBrokerSuffix(normalized);
    if (suffixStripped !== normalized) {
      if (cache.bySymbolName.has(suffixStripped)) return cache.bySymbolName.get(suffixStripped);
      const suffixStrippedAndPunct = suffixStripped.replace(/[^A-Z0-9]/g, '');
      if (cache.strippedIndex.has(suffixStrippedAndPunct)) return cache.strippedIndex.get(suffixStrippedAndPunct);
    }
    return null;
  };

  const direct = tryMatch(symbolName);
  if (direct != null) return direct;

  const aliasKey = normalizeSymbolForCTrader(symbolName);
  for (const alias of SYMBOL_ALIASES[aliasKey] || []) {
    const matched = tryMatch(alias);
    if (matched != null) return matched;
  }

  // Every alias we know of has already missed for this broker -- log the
  // account's actual symbol names so whoever's debugging this can find the
  // real spelling and add it to SYMBOL_ALIASES, instead of guessing blind.
  // (This is the same class of bug fixed twice before for USTEC/DOW/crypto
  // names -- each broker spells index/commodity CFDs differently.)
  console.warn(
    `[ctraderReplay] No symbol match for "${symbolName}" (tried: ${[symbolName, ...(SYMBOL_ALIASES[aliasKey] || [])].join(', ')}). ` +
    `This account's actual symbols: ${[...cache.bySymbolName.keys()].sort().join(', ')}`
  );
  return null;
}

function normalizeSymbolForCTrader(raw) {
  return String(raw || '').toUpperCase().trim();
}

// MT5 broker symbols often carry account-type suffixes ('XAUUSDm', 'EURUSD.a',
// 'EURUSD+'). Only used as a fallback match once the exact name has already
// failed, since applying it eagerly would corrupt real words ending in
// 'm'/'n' (BITCOIN, PLATINUM).
function stripBrokerSuffix(normalized) {
  return normalized.replace(/[mn+\.]+$/i, '');
}

// The account's actual tradable symbol names, so callers can offer a picker
// instead of having the user guess a broker-specific spelling (the same
// guesswork SYMBOL_ALIASES exists to paper over further down the pipeline).
//
// Unlike getTrendbars (which has a specific trade/account to target),
// there's no way to know which of the owner's connections is "right" here --
// and a connection can be a stored token cTrader itself no longer recognizes
// (the account was removed/deactivated on the broker's side after we saved
// it) without that being visible from our side until we try to use it. So
// this tries every connection, most recently connected first, instead of
// hard-failing on whichever happens to be oldest.
async function listAccountSymbols({ userId, preferredCtidTraderAccountId }) {
  if (preferredCtidTraderAccountId) {
    const connectionInfo = await loadConnection(userId, preferredCtidTraderAccountId);
    if (!connectionInfo) {
      const err = new Error('cTrader is not connected. Connect it on the Accounts page.');
      err.code = 'NOT_CONNECTED';
      throw err;
    }
    const client = await getAuthenticatedClient(connectionInfo);
    const cache = await getSymbolCache(client, connectionInfo.ctidTraderAccountId);
    return [...cache.bySymbolName.keys()].sort();
  }

  const connections = await listConnections(userId);
  if (!connections.length) {
    const err = new Error('cTrader is not connected. Connect it on the Accounts page.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  let lastError = null;
  for (const connection of [...connections].reverse()) {
    try {
      const connectionInfo = await refreshConnectionIfNeeded(connection, userId);
      const client = await getAuthenticatedClient(connectionInfo);
      const cache = await getSymbolCache(client, connectionInfo.ctidTraderAccountId);
      return [...cache.bySymbolName.keys()].sort();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const TRENDBARS_PER_REQUEST = 1500;
// Upper bound on pages per call (~21k bars) so one chart request can't hammer
// the cTrader connection.
const MAX_TRENDBAR_PAGES = 14;

// cTrader allows about 5 historical-data requests a second per connection and
// answers faster bursts with "You are being rate limited" -- which used to fail
// a whole strategy run while its candles loaded page after page. Requests on
// one account are spaced out, and a rate-limit answer is waited out and retried.
const TRENDBAR_MIN_GAP_MS = 250;
const TRENDBAR_RETRIES = 5;
const trendbarPace = new Map(); // ctidTraderAccountId -> promise of the last request's slot
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isRateLimited(err) {
  return ['REQUEST_FREQUENCY_EXCEEDED', 'BLOCKED_PAYLOAD_TYPE'].includes(err?.errorCode) || /rate limit/i.test(err?.message || '');
}

async function pacedTrendbarRequest(client, accountId, fields) {
  for (let attempt = 0; ; attempt++) {
    const key = String(accountId);
    const slot = (trendbarPace.get(key) || Promise.resolve()).then(() => sleep(TRENDBAR_MIN_GAP_MS));
    trendbarPace.set(key, slot);
    await slot;
    try {
      return await client.request(PAYLOAD_TYPE.GET_TRENDBARS_REQ, fields);
    } catch (err) {
      if (!isRateLimited(err) || attempt >= TRENDBAR_RETRIES) throw err;
      await sleep(Number(err.retryAfter) > 0 ? Number(err.retryAfter) * 1000 : 1000 * 2 ** attempt);
    }
  }
}

// The core Replay data call: historical candles for one symbol/window from
// the owner's connected cTrader account.
// `maxPages` > 1 opts into paging past the 1500-bar-per-request limit
// (Backtest charts); other callers keep the single newest page.
async function getTrendbars({ userId, symbol, periodLabel, fromMs, toMs, preferredCtidTraderAccountId, maxPages = 1 }) {
  const period = PERIOD_BY_LABEL[periodLabel];
  if (!period) throw new Error(`Unsupported replay interval: ${periodLabel}`);

  let connectionInfo = await loadConnection(userId, preferredCtidTraderAccountId);
  if (!connectionInfo) {
    const err = new Error('cTrader is not connected. Connect it on the Accounts page to use Trade Replay.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  let client = await getAuthenticatedClient(connectionInfo);
  let symbolId = await resolveSymbolId(client, connectionInfo.ctidTraderAccountId, symbol);
  // The default (oldest) connection may not list a symbol another of the
  // owner's accounts has -- list_symbols reads the newest one, so a symbol it
  // offered could then fail here. Without a specific account asked for, try
  // the other connections, newest first.
  if (symbolId == null && !preferredCtidTraderAccountId) {
    for (const connection of [...await listConnections(userId)].reverse()) {
      if (String(connection.ctidTraderAccountId) === String(connectionInfo.ctidTraderAccountId)) continue;
      try {
        const info = await refreshConnectionIfNeeded(connection, userId);
        const otherClient = await getAuthenticatedClient(info);
        const id = await resolveSymbolId(otherClient, info.ctidTraderAccountId, symbol);
        if (id != null) { connectionInfo = info; client = otherClient; symbolId = id; break; }
      } catch {
        // A connection cTrader no longer accepts: try the next one.
      }
    }
  }
  if (symbolId == null) {
    const err = new Error(`cTrader does not have a symbol matching "${symbol}" on this account.`);
    err.code = 'SYMBOL_NOT_FOUND';
    throw err;
  }

  // cTrader returns at most TRENDBARS_PER_REQUEST bars per GET_TRENDBARS_REQ
  // (the newest ones before toTimestamp), so walk backwards page by page until
  // the window is covered, then stitch the pages together.
  const fromSeconds = Math.floor(fromMs / 1000);
  const toSeconds = Math.ceil(toMs / 1000);
  const bars = [];
  let cursorMs = Math.floor(toMs);
  const pages = Math.max(1, Math.min(MAX_TRENDBAR_PAGES, Math.floor(maxPages)));
  for (let page = 0; page < pages; page++) {
    const res = await pacedTrendbarRequest(client, connectionInfo.ctidTraderAccountId, {
      ctidTraderAccountId: Number(connectionInfo.ctidTraderAccountId),
      fromTimestamp: Math.floor(fromMs),
      toTimestamp: cursorMs,
      period,
      symbolId,
      count: TRENDBARS_PER_REQUEST,
    });
    const pageBars = res.trendbar || [];
    if (!pageBars.length) break;
    bars.push(...pageBars);
    const earliestMs = Math.min(...pageBars.map(b => Number(b.utcTimestampInMinutes) * 60000));
    if (earliestMs <= fromMs || pageBars.length < TRENDBARS_PER_REQUEST || earliestMs >= cursorMs) break;
    cursorMs = earliestMs - 1;
  }

  // Prices are transmitted as 1/100000ths of a unit, and open/high/close are
  // deltas above the bar's low (see OpenApiModelMessages.proto ProtoOATrendbar).
  const seen = new Set();
  const candles = bars
    .map(bar => {
      const low = Number(bar.low) / 100000;
      return {
        time: Number(bar.utcTimestampInMinutes) * 60,
        open: low + Number(bar.deltaOpen || 0) / 100000,
        high: low + Number(bar.deltaHigh || 0) / 100000,
        low,
        close: low + Number(bar.deltaClose || 0) / 100000,
        // Tick volume (ProtoOATrendbar.volume) -- used by the Backtest chart's volume bars.
        volume: Number(bar.volume || 0),
      };
    })
    // cTrader's GET_TRENDBARS_REQ ignores fromTimestamp when count is also
    // set -- it just returns `count` bars ending at toTimestamp, which can
    // reach years further back than requested. Enforce the requested lower
    // bound ourselves instead of trusting the broker to honor it.
    .filter(c => c.time >= fromSeconds && c.time <= toSeconds && !seen.has(c.time) && seen.add(c.time))
    .sort((a, b) => a.time - b.time);

  return { candles, source: 'ctrader', sourceLabel: 'cTrader', brokerSymbol: symbol };
}

module.exports = { fetchAccountList, getTrendbars, loadConnection, listConnections, getAuthenticatedClient, listAccountSymbols, pacedTrendbarRequest };
