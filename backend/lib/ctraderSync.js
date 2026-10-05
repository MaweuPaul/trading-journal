const mongoose = require('mongoose');
const Trade = require('../models/Trade');
const AccountEvent = require('../models/AccountEvent');
const TradingAccount = require('../models/TradingAccount');
const { loadConnection, listConnections, getAuthenticatedClient } = require('./ctraderReplay');
const { PAYLOAD_TYPE } = require('./ctraderClient');
const { convertCTraderPnlToGross } = require('./ctraderPnl');
const { isLossSideStop, moneyPerPricePerLotBySymbol, riskFromStop } = require('./tradeRisk');

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const MAX_DEAL_PAGES = 50; // 50 * 1000 rows = plenty for a personal account's full history
const DEFAULT_MONEY_DIGITS = 2;
const MIN_ORDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const ORDER_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // positions can be opened well before the deals being synced
const LOT_UNITS = 100000; // cTrader volume is in 1/100 of a unit; a standard lot is 100,000 units

function scale(value, moneyDigits) {
  return Number(value || 0) / Math.pow(10, Number.isFinite(moneyDigits) ? moneyDigits : DEFAULT_MONEY_DIGITS);
}

async function resolveSymbolNames(client, ctidTraderAccountId) {
  const res = await client.request(PAYLOAD_TYPE.SYMBOLS_LIST_REQ, {
    ctidTraderAccountId: Number(ctidTraderAccountId),
    includeArchivedSymbols: false,
  });
  const byId = new Map();
  for (const symbol of res.symbol || []) {
    byId.set(String(symbol.symbolId), String(symbol.symbolName || `Symbol${symbol.symbolId}`));
  }
  return byId;
}

// Per-symbol lot size ("units per lot", in the same hundredths-of-a-unit
// convention as deal volumes) — 100,000 for FX pairs but wildly different for
// other instrument classes (crypto is commonly 1 whole coin per lot, i.e.
// lotSize=100). Without this a BTCUSD deal's volume divided by the FX
// default of 100,000 units/lot produces a lot size ~100,000x too small.
async function fetchSymbolLotSizes(client, ctidTraderAccountId, symbolIds) {
  const byId = new Map();
  if (symbolIds.length === 0) return byId;
  const res = await client.request(PAYLOAD_TYPE.SYMBOL_BY_ID_REQ, {
    ctidTraderAccountId: Number(ctidTraderAccountId),
    symbolId: symbolIds.map(Number),
  });
  for (const symbol of res.symbol || []) {
    const lotSize = Number(symbol.lotSize);
    if (Number.isFinite(lotSize) && lotSize > 0) byId.set(String(symbol.symbolId), lotSize);
  }
  return byId;
}

async function fetchTrader(client, ctidTraderAccountId) {
  const res = await client.request(PAYLOAD_TYPE.TRADER_REQ, { ctidTraderAccountId: Number(ctidTraderAccountId) });
  return res.trader;
}

// The deal-history API only accepts a bounded [from, to] window and flags
// hasMore when a request's row cap was hit — there's no cursor/offset, so we
// page by walking toTimestamp backward to just before the oldest deal seen.
async function fetchAllDeals(client, ctidTraderAccountId, fromMs, toMs) {
  const deals = [];
  let windowTo = toMs;
  for (let page = 0; page < MAX_DEAL_PAGES; page++) {
    const res = await client.request(PAYLOAD_TYPE.DEAL_LIST_REQ, {
      ctidTraderAccountId: Number(ctidTraderAccountId),
      fromTimestamp: Math.floor(fromMs),
      toTimestamp: Math.floor(windowTo),
      maxRows: 1000,
    });
    const batch = res.deal || [];
    deals.push(...batch);
    if (!res.hasMore || batch.length === 0) break;
    const earliest = Math.min(...batch.map(deal => Number(deal.executionTimestamp)));
    const nextWindowTo = earliest - 1;
    if (!Number.isFinite(nextWindowTo) || nextWindowTo <= fromMs || nextWindowTo >= windowTo) break;
    windowTo = nextWindowTo;
  }
  return deals;
}

// Cash flow history is capped to a 1-week window per request, so we walk
// forward from fromMs a week at a time.
async function fetchAllCashFlow(client, ctidTraderAccountId, fromMs, toMs) {
  const events = [];
  let windowFrom = fromMs;
  while (windowFrom < toMs) {
    const windowTo = Math.min(windowFrom + MS_PER_WEEK - 1000, toMs);
    const res = await client.request(PAYLOAD_TYPE.CASH_FLOW_HISTORY_LIST_REQ, {
      ctidTraderAccountId: Number(ctidTraderAccountId),
      fromTimestamp: Math.floor(windowFrom),
      toTimestamp: Math.floor(windowTo),
    });
    events.push(...(res.depositWithdraw || []));
    windowFrom = windowTo + 1;
  }
  return events;
}

// Order history (ProtoOAOrderListReq) is where the stop on a position's
// opening order lives; deals don't carry it. The request has no row cap or
// cursor, only hasMore, so a window that comes back with hasMore (or is
// refused as too wide) is split in half until each piece fits.
async function fetchAllOrders(client, ctidTraderAccountId, fromMs, toMs, depth = 0) {
  let res;
  try {
    res = await client.request(PAYLOAD_TYPE.ORDER_LIST_REQ, {
      ctidTraderAccountId: Number(ctidTraderAccountId),
      fromTimestamp: Math.floor(fromMs),
      toTimestamp: Math.floor(toMs),
    });
  } catch (err) {
    if (toMs - fromMs <= MIN_ORDER_WINDOW_MS || depth > 12) throw err;
    res = { hasMore: true, order: [] };
  }
  if (!res.hasMore || toMs - fromMs <= MIN_ORDER_WINDOW_MS || depth > 12) return res.order || [];
  const mid = Math.floor((fromMs + toMs) / 2);
  const older = await fetchAllOrders(client, ctidTraderAccountId, fromMs, mid, depth + 1);
  const newer = await fetchAllOrders(client, ctidTraderAccountId, mid + 1, toMs, depth + 1);
  return [...older, ...newer];
}

const ORDER_TYPE = { MARKET: 1, LIMIT: 2, STOP: 3, STOP_LOSS_TAKE_PROFIT: 4, MARKET_RANGE: 5, STOP_LIMIT: 6 };
const price = value => (Number(value) > 0 ? Number(value) : null);
const orderTime = order => Number(order.tradeData?.openTimestamp) || Number(order.utcLastUpdateTimestamp) || 0;

/**
 * The stop and target each position was opened with, keyed by positionId.
 * The opening order's own stopLoss (or relativeStopLoss, in 1/100000 of
 * price) comes first; failing that, the earliest stop-loss/take-profit order
 * placed on the position. A stop on the profit side of the entry (already
 * moved to break-even or beyond) isn't the risk taken, so it's skipped.
 * `entries` maps positionId -> { direction, entryPrice }.
 */
function initialStopsByPosition(orders, entries) {
  const byPosition = new Map();
  for (const order of orders) {
    const key = String(order.positionId || '');
    if (!key || key === '0' || !entries.has(key)) continue;
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(order);
  }
  const out = new Map();
  for (const [key, list] of byPosition) {
    const { direction, entryPrice } = entries.get(key);
    const sign = direction === 'SELL' ? -1 : 1;
    list.sort((a, b) => orderTime(a) - orderTime(b));
    const opening = list.filter(o => !o.closingOrder && Number(o.orderType) !== ORDER_TYPE.STOP_LOSS_TAKE_PROFIT);
    const protective = list.filter(o => Number(o.orderType) === ORDER_TYPE.STOP_LOSS_TAKE_PROFIT);
    const stopOf = o => price(o.stopLoss)
      ?? (Number(o.relativeStopLoss) > 0 ? entryPrice - sign * Number(o.relativeStopLoss) / 100000 : null);
    const targetOf = o => price(o.takeProfit)
      ?? (Number(o.relativeTakeProfit) > 0 ? entryPrice + sign * Number(o.relativeTakeProfit) / 100000 : null);
    const candidates = [
      ...opening.map(stopOf),
      ...protective.map(o => stopOf(o) ?? price(o.stopPrice)),
    ];
    const stopLoss = candidates.find(s => s != null && isLossSideStop(direction, entryPrice, s)) ?? null;
    const takeProfit = [...opening, ...protective].map(targetOf).find(t => t != null && (t - entryPrice) * sign > 0) ?? null;
    if (stopLoss != null || takeProfit != null) out.set(key, { stopLoss, takeProfit });
  }
  return out;
}

// The $set for each trade that gained a stop or target from `stops`, with
// the risk the stop implies. `perLotBySymbol` prices trades that closed flat.
function stopUpdates(trades, stops, perLotBySymbol = moneyPerPricePerLotBySymbol(trades)) {
  const updates = [];
  for (const t of trades) {
    const found = stops.get(String(t.positionId));
    if (!found) continue;
    const risk = found.stopLoss != null ? riskFromStop(t, found.stopLoss, { perLotBySymbol }) : { riskUSD: null, riskPercent: null };
    updates.push({ _id: t._id, dealId: t.dealId, set: { stopLoss: found.stopLoss, takeProfit: found.takeProfit, ...risk } });
  }
  return updates;
}

// Fill in the stop on this account's trades that have none: those closed
// since `sinceMs`, or every one of them on the account's first pass (older
// trades were synced before stops were read). A stop typed in by hand is
// never touched, since only trades with no stop are looked at.
async function fillMissingStops(client, ctidTraderAccountId, userId, accountKey, { sinceMs, nowMs }) {
  const filter = { user: userId, accountKey, stopLoss: null, positionId: { $nin: [null, ''] } };
  if (sinceMs != null) filter.closeTime = { $gte: new Date(sinceMs) };
  const missing = await Trade.find(filter).lean();
  if (!missing.length) return 0;
  const entries = new Map(missing.map(t => [String(t.positionId), { direction: t.direction, entryPrice: Number(t.entryPrice) }]));
  const earliestOpen = Math.min(...missing.map(t => new Date(t.openTime).getTime()).filter(Number.isFinite));
  const orders = await fetchAllOrders(client, ctidTraderAccountId, Math.max(0, earliestOpen - ORDER_LOOKBACK_MS), nowMs);
  const stops = initialStopsByPosition(orders, entries);
  if (!stops.size) return 0;
  const symbols = [...new Set(missing.map(t => t.symbol))];
  const priced = await Trade.find({ user: userId, accountKey, symbol: { $in: symbols } }).select('symbol direction entryPrice exitPrice lotSize pnlUSD swap commission accountKey grossPnl').lean();
  let filled = 0;
  for (const u of stopUpdates(missing, stops, moneyPerPricePerLotBySymbol(priced))) {
    const res = await Trade.updateOne({ _id: u._id, stopLoss: null }, { $set: u.set });
    filled += res.modifiedCount || 0;
  }
  return filled;
}

// Deals are individual executions, not closed trades — group by positionId so
// a partial close still resolves against the position's real opening price
// and open time instead of guessing from the closing deal alone.
function buildTradesFromDeals(deals, symbolNames, symbolLotSizes, accountIdentity) {
  const byPosition = new Map();
  for (const deal of deals) {
    const key = String(deal.positionId);
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(deal);
  }

  const trades = [];
  for (const positionDeals of byPosition.values()) {
    positionDeals.sort((a, b) => Number(a.executionTimestamp) - Number(b.executionTimestamp));
    const openDeal = positionDeals[0];
    const openDirection = Number(openDeal.tradeSide) === 1 ? 'BUY' : 'SELL'; // ProtoOATradeSide: BUY=1, SELL=2
    const openCommissionMoneyDigits = openDeal.moneyDigits;
    const openCommission = scale(openDeal.commission, openCommissionMoneyDigits);

    for (const deal of positionDeals) {
      const detail = deal.closePositionDetail;
      if (!detail) continue; // opening/increasing deals carry no realized P&L
      const moneyDigits = Number.isFinite(detail.moneyDigits) ? detail.moneyDigits : DEFAULT_MONEY_DIGITS;
      const grossProfit = scale(detail.grossProfit, moneyDigits);
      const swap = scale(detail.swap, moneyDigits);
      const closeCommission = scale(detail.commission, moneyDigits);
      const commission = closeCommission + (deal.dealId === openDeal.dealId ? 0 : openCommission);
      // Like an MT5 trade: pnlUSD is the price profit, with commission and
      // swap kept separately (every stat adds them back to get the net).
      const pnlUSD = grossProfit;
      const runningBalance = scale(detail.balance, moneyDigits);
      const balanceBeforeTrade = runningBalance - (grossProfit + swap + commission);
      const pnlPct = balanceBeforeTrade > 0 ? (pnlUSD / balanceBeforeTrade) * 100 : 0;
      const unitsPerLot = symbolLotSizes.get(String(deal.symbolId)) || LOT_UNITS * 100;
      const lotSize = Number(detail.closedVolume ?? deal.filledVolume ?? deal.volume ?? 0) / unitsPerLot;
      const openTimeMs = Number(openDeal.executionTimestamp);
      const closeTimeMs = Number(deal.executionTimestamp);

      trades.push({
        dealId: String(deal.dealId),
        positionId: String(deal.positionId),
        symbol: symbolNames.get(String(deal.symbolId)) || `Symbol${deal.symbolId}`,
        direction: openDirection,
        entryPrice: Number(detail.entryPrice),
        exitPrice: Number(deal.executionPrice),
        lotSize,
        pnlUSD,
        pnlPct,
        commission,
        swap,
        openTime: new Date(openTimeMs).toISOString(),
        closeTime: new Date(closeTimeMs).toISOString(),
        durationMinutes: Math.max(0, Math.round((closeTimeMs - openTimeMs) / 60000)),
        runningBalance,
        // Deals don't carry the SL/TP; withStops fills them in from order history.
        stopLoss: null, takeProfit: null, riskUSD: null, riskPercent: null,
        exitTrigger: '', magic: 0, contractSize: null, tickValue: null,
        ...accountIdentity,
      });
    }
  }
  return trades;
}

function buildAccountEventsFromCashFlow(cashFlowEvents, accountIdentity) {
  return cashFlowEvents.map(event => {
    const moneyDigits = Number.isFinite(event.moneyDigits) ? event.moneyDigits : DEFAULT_MONEY_DIGITS;
    return {
      externalId: `ctrader-${event.balanceHistoryId}`,
      type: Number(event.operationType) === 0 ? 'deposit' : 'withdrawal',
      amount: Math.abs(scale(event.delta, moneyDigits)),
      currency: 'USD',
      occurredAt: new Date(Number(event.changeBalanceTimestamp)).toISOString(),
      note: event.externalNote || '',
      balanceAfter: scale(event.balance, moneyDigits),
      ...accountIdentity,
    };
  });
}

async function getOrCreateTradingAccount(userId, connectionInfo, trader) {
  const accountKey = `ctrader:${connectionInfo.ctidTraderAccountId}`;
  const broker = connectionInfo.brokerTitle ? ` (${connectionInfo.brokerTitle})` : connectionInfo.traderLogin ? ` · ${connectionInfo.traderLogin}` : '';
  const label = `cTrader ${connectionInfo.isLive ? 'Live' : 'Demo'}${broker}`;
  return TradingAccount.findOneAndUpdate(
    { user: userId, accountKey },
    {
      $set: {
        provider: 'ctrader',
        label,
        archivedAt: null,
        actualAccountType: connectionInfo.isLive ? 'live' : 'demo',
        lastStatus: 'connected',
        lastConnectedAt: new Date(),
        lastBalance: trader ? scale(trader.balance, trader.moneyDigits) : null,
      },
      // Only set enabled on first creation — otherwise a manual Sync Now
      // click would silently flip the "Sync enabled" toggle back on every
      // time, making it a no-op control.
      $setOnInsert: { user: userId, accountKey, enabled: true },
    },
    { upsert: true, new: true },
  );
}

async function upsertTrades(userId, trades) {
  let inserted = 0;
  let skipped = 0;
  for (const t of trades) {
    try {
      const existing = await Trade.findOne({ user: userId, accountKey: t.accountKey, dealId: t.dealId }).select('_id');
      if (existing) { skipped++; continue; }
      await Trade.create({
        dealId: t.dealId, positionId: t.positionId, symbol: t.symbol, direction: t.direction,
        entryPrice: t.entryPrice, exitPrice: t.exitPrice, lotSize: t.lotSize,
        pnlUSD: t.pnlUSD, pnlPct: t.pnlPct, commission: t.commission, swap: t.swap, grossPnl: true,
        openTime: new Date(t.openTime), closeTime: new Date(t.closeTime),
        durationMinutes: t.durationMinutes, runningBalance: t.runningBalance,
        stopLoss: t.stopLoss, takeProfit: t.takeProfit, riskUSD: t.riskUSD, riskPercent: t.riskPercent,
        exitTrigger: t.exitTrigger, magic: t.magic, contractSize: t.contractSize, tickValue: t.tickValue,
        accountKey: t.accountKey, accountType: t.accountType, accountName: t.accountName, tradingAccount: t.tradingAccount,
        user: userId,
      });
      inserted++;
    } catch (err) {
      if (err.code === 11000) skipped++;
      else throw err;
    }
  }
  return { inserted, skipped };
}

async function upsertAccountEvents(userId, events) {
  let inserted = 0;
  let skipped = 0;
  for (const e of events) {
    const existing = await AccountEvent.findOne({ user: userId, accountKey: e.accountKey, externalId: e.externalId }).select('_id');
    if (existing) { skipped++; continue; }
    await AccountEvent.create({
      type: e.type, amount: e.amount, currency: e.currency, occurredAt: new Date(e.occurredAt), note: e.note,
      source: 'ctrader', externalId: e.externalId, balanceAfter: e.balanceAfter,
      accountKey: e.accountKey, tradingAccount: e.tradingAccount, user: userId,
    });
    inserted++;
  }
  return { inserted, skipped };
}

// The whole point of a manual "Sync Now" click: pull new deals + cash flow
// from cTrader's cloud API and fold them into the journal exactly like an
// MT5 sync would, without needing a local agent process.
async function syncOneConnection(userId, connectionInfo) {
  const client = await getAuthenticatedClient(connectionInfo);
  const trader = await fetchTrader(client, connectionInfo.ctidTraderAccountId);
  const tradingAccount = await getOrCreateTradingAccount(userId, connectionInfo, trader);

  if (!tradingAccount.enabled) {
    const err = new Error('Syncing is disabled for this cTrader account. Enable it on the Accounts page first.');
    err.code = 'DISABLED';
    throw err;
  }

  const accountIdentity = {
    accountKey: tradingAccount.accountKey,
    accountType: tradingAccount.actualAccountType,
    accountName: tradingAccount.label,
    tradingAccount: tradingAccount._id,
  };

  const nowMs = Date.now();
  // Resync from a day before the last successful sync to absorb any deals
  // that were still settling, or from account registration on a first sync.
  const fromMs = tradingAccount.lastSyncAt
    ? tradingAccount.lastSyncAt.getTime() - 24 * 60 * 60 * 1000
    : Number(trader.registrationTimestamp) || nowMs - 365 * 24 * 60 * 60 * 1000;

  const [symbolNames, deals, cashFlowEvents] = await Promise.all([
    resolveSymbolNames(client, connectionInfo.ctidTraderAccountId),
    fetchAllDeals(client, connectionInfo.ctidTraderAccountId, fromMs, nowMs),
    fetchAllCashFlow(client, connectionInfo.ctidTraderAccountId, fromMs, nowMs),
  ]);
  const dealSymbolIds = [...new Set(deals.map(deal => String(deal.symbolId)))];
  const symbolLotSizes = await fetchSymbolLotSizes(client, connectionInfo.ctidTraderAccountId, dealSymbolIds);

  const trades = buildTradesFromDeals(deals, symbolNames, symbolLotSizes, accountIdentity);
  const accountEvents = buildAccountEventsFromCashFlow(cashFlowEvents, accountIdentity);

  await convertCTraderPnlToGross({ userId }); // older trades first, so the account never mixes net and gross
  const tradeResult = await upsertTrades(userId, trades);
  const eventResult = await upsertAccountEvents(userId, accountEvents);

  // Stops come from a separate history call; if it fails the trades are still synced.
  const firstStopPass = !tradingAccount.stopsBackfilledAt;
  let stopsFilled = 0, stopsError = '';
  try {
    stopsFilled = await fillMissingStops(client, connectionInfo.ctidTraderAccountId, userId, tradingAccount.accountKey, { sinceMs: firstStopPass ? null : fromMs, nowMs });
  } catch (err) {
    stopsError = err.message;
  }

  await TradingAccount.updateOne({ _id: tradingAccount._id }, {
    $set: { lastSyncAt: new Date(), ...(firstStopPass && !stopsError ? { stopsBackfilledAt: new Date() } : {}) },
  });

  return {
    ctidTraderAccountId: connectionInfo.ctidTraderAccountId,
    accountKey: tradingAccount.accountKey,
    label: tradingAccount.label,
    inserted: tradeResult.inserted, skipped: tradeResult.skipped, total: trades.length,
    cashFlowInserted: eventResult.inserted, cashFlowSkipped: eventResult.skipped, cashFlowTotal: accountEvents.length,
    stopsFilled, ...(stopsError ? { stopsError } : {}),
  };
}

// Syncs a specific connection when `ctidTraderAccountId` is given, otherwise
// every connected cTrader account for this owner. One account's failure
// (e.g. a revoked token) doesn't abort the others — it's reported inline.
async function syncCTraderTrades(userId, ctidTraderAccountId) {
  if (mongoose.connection.readyState !== 1) {
    const err = new Error('cTrader sync requires MongoDB to be connected.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  let connections;
  if (ctidTraderAccountId) {
    const connectionInfo = await loadConnection(userId, ctidTraderAccountId);
    if (!connectionInfo) {
      const err = new Error('That cTrader account is not connected.');
      err.code = 'NOT_CONNECTED';
      throw err;
    }
    connections = [connectionInfo];
  } else {
    const docs = await listConnections(userId);
    if (docs.length === 0) {
      const err = new Error('cTrader is not connected. Connect it on the Accounts page first.');
      err.code = 'NOT_CONNECTED';
      throw err;
    }
    connections = await Promise.all(docs.map(doc => loadConnection(userId, doc.ctidTraderAccountId)));
  }

  const accounts = [];
  for (const connectionInfo of connections) {
    try {
      accounts.push(await syncOneConnection(userId, connectionInfo));
    } catch (err) {
      accounts.push({ ctidTraderAccountId: connectionInfo.ctidTraderAccountId, error: err.message });
    }
  }

  return {
    accounts,
    inserted: accounts.reduce((sum, a) => sum + (a.inserted || 0), 0),
    skipped: accounts.reduce((sum, a) => sum + (a.skipped || 0), 0),
    cashFlowInserted: accounts.reduce((sum, a) => sum + (a.cashFlowInserted || 0), 0),
    cashFlowSkipped: accounts.reduce((sum, a) => sum + (a.cashFlowSkipped || 0), 0),
    stopsFilled: accounts.reduce((sum, a) => sum + (a.stopsFilled || 0), 0),
  };
}

module.exports = { syncCTraderTrades, buildTradesFromDeals, buildAccountEventsFromCashFlow, fetchAllOrders, initialStopsByPosition, stopUpdates };
