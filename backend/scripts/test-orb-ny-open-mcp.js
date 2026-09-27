/*
 * Exact no-hindsight MCP exercise for the ORB (New York Open) strategy:
 * - XAUUSD M1
 * - 09:25–09:30 America/New_York range
 * - first M1 close beyond the range, daily midpoint bias required
 * - entry at next bar open, opposite range edge stop
 * - target one range width from the actual fill
 *
 * A temporary MCP key is created in tradejournal_test and deleted in finally.
 * Trades are deliberately logged as AGENT runs under a unique strategy name.
 */
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiKey = require('../models/ApiKey');
const CTraderConnection = require('../models/CTraderConnection');

const BASE = process.env.MCP_TEST_URL || 'http://127.0.0.1:4000/api/mcp';
const START = process.env.ORB_FROM || '2025-01-02';
const END = process.env.ORB_TO || '2025-02-15';
const SYMBOL = process.env.ORB_SYMBOL || 'XAUUSD';
const STRATEGY = `ORB-NY-exact-${Date.now().toString(36)}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function zonedUtc(date, hour, minute, timeZone = 'America/New_York') {
  const [y, m, d] = date.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, hour + 5, minute);
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
    const displayedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess = Date.UTC(y, m - 1, d, hour, minute) - (displayedAsUtc - guess);
  }
  return guess;
}
function dates(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t < Date.parse(`${to}T00:00:00Z`); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
function summarize(trades) {
  const wins = trades.filter(t => t.rMultiple > 0);
  const losses = trades.filter(t => t.rMultiple < 0);
  const grossWin = wins.reduce((n, t) => n + t.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((n, t) => n + t.rMultiple, 0));
  const totalR = trades.reduce((n, t) => n + t.rMultiple, 0);
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const t of trades) { equity += t.rMultiple; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: trades.length - wins.length - losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    totalR,
    avgR: trades.length ? totalR / trades.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0,
    maxDrawdownR,
  };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_TEST_DB_NAME || 'tradejournal_test' });
  const connection = await CTraderConnection.findOne({ ctidTraderAccountId: { $ne: '' } }).lean();
  if (!connection) throw new Error('No cTrader account is connected in tradejournal_test.');
  const plainKey = `tjk_${crypto.randomBytes(32).toString('base64url')}`;
  const keyDoc = await ApiKey.create({
    user: connection.user, name: 'Temporary exact ORB MCP test',
    keyHash: crypto.createHash('sha256').update(plainKey).digest('hex'),
    prefix: plainKey.slice(0, 10), scopes: ['backtest'],
  });
  let rpcId = 0;
  const rpc = async (method, params) => {
    await wait(650); // stay below the MCP key's 120 requests/minute limit
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${plainKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error?.message || `MCP HTTP ${res.status}`);
    return body.result;
  };
  const call = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    const data = JSON.parse(result.content[0].text);
    if (result.isError) throw new Error(`${name}: ${data.error}`);
    return data;
  };
  let sessionId;
  const observed = [];
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'orb-ny-open-test', version: '1' } });
    const symbols = await call('list_symbols', { search: SYMBOL });
    if (!symbols.symbols.includes(SYMBOL)) throw new Error(`${SYMBOL} is not available on the connected cTrader account.`);
    await call('create_strategy', { name: STRATEGY, description: 'Exact ORB NY Open: 09:25-09:30 NY range; first closing break with daily midpoint bias; next-open fill; opposite edge stop; measured move x1.' });
    const started = await call('start_session', { symbol: SYMBOL, interval: '1min', from: `${START}T00:00:00Z`, to: `${END}T23:59:00Z`, strategy: STRATEGY, context: 20, gapFills: true });
    sessionId = started.sessionId;
    let previousMidpoint = null;
    for (const date of dates(START, END)) {
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const rangeEnd = zonedUtc(date, 9, 30);
      const monitorEnd = zonedUtc(date, 15, 30);
      const state = await call('get_state', { sessionId });
      if (Date.parse(state.clock) > rangeEnd) { console.log(`${date} skipped (clock advanced past NY open)`); continue; }
      const moved = await call('step', { sessionId, untilTime: new Date(rangeEnd).toISOString(), stopOnTradeExit: false, maxBars: 2000 });
      if (moved.events.some(e => e.type === 'session_end')) break;
      const view = await call('get_candles', { sessionId, timeframe: '1min', count: 5 });
      const range = view.candles.filter(c => {
        const t = Date.parse(c.time);
        return t >= rangeEnd - 5 * 60000 && t < rangeEnd;
      });
      if (range.length !== 5) { console.log(`${date} skipped (no complete 09:25-09:30 range)`); continue; }
      const high = Math.max(...range.map(c => c.high));
      const low = Math.min(...range.map(c => c.low));
      const midpoint = (high + low) / 2;
      const bias = previousMidpoint == null ? null : midpoint > previousMidpoint ? 'long' : midpoint < previousMidpoint ? 'short' : null;
      previousMidpoint = midpoint;
      if (!bias) { console.log(`${date} range recorded (no prior-day bias)`); continue; }
      const breakout = await call('step', { sessionId, untilCloseAbove: high, untilCloseBelow: low, untilTime: new Date(monitorEnd).toISOString(), stopOnTradeExit: false, maxBars: 400 });
      const event = breakout.events.find(e => e.type === 'close_beyond');
      if (!event) { console.log(`${date} no breakout`); continue; }
      const direction = event.side === 'above' ? 'long' : 'short';
      if (direction !== bias) { console.log(`${date} first break ${direction}, rejected by ${bias} bias`); continue; }
      await call('open_trade', { sessionId, direction, stopLoss: direction === 'long' ? low : high, takeProfitDistance: high - low, fill: 'next_open', riskAmount: 100 });
      const fill = await call('step', { sessionId, bars: 1, stopOnTradeExit: true });
      if (fill.events.some(e => e.type === 'order_cancelled')) { console.log(`${date} order cancelled on gap`); continue; }
      let result = fill;
      if (!result.state.closedTrade) result = await call('step', { sessionId, bars: 4320, stopOnTradeExit: true, maxBars: 4320 });
      if (!result.state.closedTrade) {
        result = await call('close_trade', { sessionId });
        result = { state: { closedTrade: result.closed } };
      }
      const trade = result.state.closedTrade;
      observed.push({ date, direction, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice, rMultiple: trade.rMultiple, outcome: trade.outcome });
      await call('log_trade', { sessionId, name: `${date} ${SYMBOL} ORB`, notes: 'Exact 5-minute pre-NY-open range breakout with daily midpoint bias. Entry filled at next M1 open.', lesson: 'Mechanical strategy test; review slippage/news sensitivity separately.', setupQuality: 5, executionQuality: 5, planFollowed: true, tags: ['NY Open', 'ORB', 'Measured Move x1'] });
      console.log(`${date} ${direction} ${trade.outcome} ${Number(trade.rMultiple).toFixed(3)}R`);
    }
    const mcpMetrics = await call('get_metrics', { strategy: STRATEGY, source: 'agent' });
    await call('end_session', { sessionId });
    sessionId = null;
    const output = { strategy: STRATEGY, symbol: SYMBOL, from: START, to: END, config: { candleMinutes: 5, monitorHours: 6, dailyBias: true, targetMode: 'measured_move', targetRangeMult: 1, nextOpenFill: true, gapFills: true }, localSummary: summarize(observed), mcpMetrics, trades: observed };
    console.log(`ORB_MCP_RESULT=${JSON.stringify(output)}`);
  } finally {
    if (sessionId) { try { await call('end_session', { sessionId }); } catch (_) {} }
    await ApiKey.deleteOne({ _id: keyDoc._id });
    await mongoose.disconnect();
  }
})().catch(err => { console.error(`ORB_MCP_ERROR=${err.message}`); process.exit(1); });
