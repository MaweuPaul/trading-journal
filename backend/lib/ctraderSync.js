const mongoose = require('mongoose');
const Trade = require('../models/Trade');
const AccountEvent = require('../models/AccountEvent');
const TradingAccount = require('../models/TradingAccount');
const { loadConnection, getAuthenticatedClient } = require('./ctraderReplay');
const { PAYLOAD_TYPE } = require('./ctraderClient');

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const MAX_DEAL_PAGES = 50; // 50 * 1000 rows = plenty for a personal account's full history
const DEFAULT_MONEY_DIGITS = 2;
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

// Deals are individual executions, not closed trades — group by positionId so
// a partial close still resolves against the position's real opening price
// and open time instead of guessing from the closing deal alone.
function buildTradesFromDeals(deals, symbolNames, accountIdentity) {
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
      const pnlUSD = grossProfit + swap + commission;
      const runningBalance = scale(detail.balance, moneyDigits);
      const balanceBeforeTrade = runningBalance - pnlUSD;
      const pnlPct = balanceBeforeTrade > 0 ? (pnlUSD / balanceBeforeTrade) * 100 : 0;
      const lotSize = Number(detail.closedVolume ?? deal.filledVolume ?? deal.volume ?? 0) / (100 * LOT_UNITS);
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
        // cTrader's historical deal/cash-flow APIs don't expose the SL/TP that
        // was on the entry order, so these stay null like any MT5 trade with
        // no recorded stop — R-multiple math already handles that gracefully.
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
  const label = `cTrader ${connectionInfo.isLive ? 'Live' : 'Demo'}${connectionInfo.traderLogin ? ` · ${connectionInfo.traderLogin}` : ''}`;
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
        pnlUSD: t.pnlUSD, pnlPct: t.pnlPct, commission: t.commission, swap: t.swap,
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
async function syncCTraderTrades(userId) {
  if (mongoose.connection.readyState !== 1) {
    const err = new Error('cTrader sync requires MongoDB to be connected.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const connectionInfo = await loadConnection(userId);
  if (!connectionInfo) {
    const err = new Error('cTrader is not connected. Connect it on the Accounts page first.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

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

  const trades = buildTradesFromDeals(deals, symbolNames, accountIdentity);
  const accountEvents = buildAccountEventsFromCashFlow(cashFlowEvents, accountIdentity);

  const tradeResult = await upsertTrades(userId, trades);
  const eventResult = await upsertAccountEvents(userId, accountEvents);

  await TradingAccount.updateOne({ _id: tradingAccount._id }, { $set: { lastSyncAt: new Date() } });

  return {
    inserted: tradeResult.inserted, skipped: tradeResult.skipped, total: trades.length,
    cashFlowInserted: eventResult.inserted, cashFlowSkipped: eventResult.skipped, cashFlowTotal: accountEvents.length,
    accountKey: tradingAccount.accountKey,
  };
}

module.exports = { syncCTraderTrades, buildTradesFromDeals, buildAccountEventsFromCashFlow };
