const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const ApiKey = require('../models/ApiKey');
const replay = require('../lib/agentReplay');
const backtestLog = require('../lib/agentBacktestLog');

// POST /api/mcp -- a Model Context Protocol server (stateless Streamable HTTP)
// that lets AI agents backtest on the owner's behalf: replay history bar by
// bar with the future hidden, place simulated trades and log them to the
// Backtest Log. Authenticated with an access key from routes/apiKeys.js,
// which works here and nowhere else.

const LAST_USED_RESOLUTION_MS = 60_000;

function unauthorized(res, message) {
  res.set('WWW-Authenticate', 'Bearer realm="tradejournal-mcp"');
  return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

// Keys only ever come in the Authorization header: morgan logs URLs, so a key
// in the query string would end up in the logs.
async function agentAuth(req, res, next) {
  const header = req.header('Authorization') || '';
  const match = /^Bearer\s+(tjk_[A-Za-z0-9_-]+)$/.exec(header.trim());
  if (!match) return unauthorized(res, 'Send an access key as "Authorization: Bearer tjk_...". Create one on the Accounts page.');
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ jsonrpc: '2.0', error: { code: -32002, message: 'The journal database is offline; agent backtesting is unavailable.' }, id: null });
  }
  try {
    const keyHash = crypto.createHash('sha256').update(match[1]).digest('hex');
    const key = await ApiKey.findOne({ keyHash, revokedAt: null });
    if (!key || !key.scopes.includes('backtest')) return unauthorized(res, 'This access key is invalid or has been revoked.');
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    }
    req.user = { userId: String(key.user), role: 'agent' };
    req.apiKey = key;
    next();
  } catch (err) {
    next(err);
  }
}

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => String(req.apiKey._id),
  handler: (req, res) => res.status(429).json({ jsonrpc: '2.0', error: { code: -32003, message: 'Rate limit: at most 120 requests a minute per access key. Use step with bars/untilPrice/stopOnTradeExit instead of one call per candle.' }, id: null }),
});

const SETUP_CODES = new Set(['NOT_CONNECTED', 'NO_ACCOUNT_SELECTED']);
function toolResult(fn) {
  return async args => {
    try {
      const result = await fn(args || {});
      // A handler can attach images (e.g. a backtest's chart snapshot) next to its JSON.
      if (result && Array.isArray(result.images)) {
        const { images, ...rest } = result;
        return { content: [{ type: 'text', text: JSON.stringify(rest) }, ...images.map(img => ({ type: 'image', data: img.data, mimeType: img.mimeType }))] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      let message = err.message || 'Something went wrong.';
      if (SETUP_CODES.has(err.code)) message = `${message} (The journal owner needs to connect cTrader on the Accounts page; you cannot fix this from here.)`;
      else if (!(err instanceof replay.AgentError) && err.code !== 'SYMBOL_NOT_FOUND') {
        console.error('MCP tool error:', err);
        message = `Server error: ${message}`;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ error: message, code: err.code || 'ERROR' }) }], isError: true };
    }
  };
}

const NO_HINDSIGHT = 'The replay never shows a candle that closes after the session clock, so decisions are made with only what a trader could have seen at that moment.';
const timeframe = z.enum(['1min', '5min', '15min', '1h', '4h', '1day']);
const sessionId = z.string().describe('Session id from start_session or list_sessions.');
const timeInput = z.union([z.string(), z.number()]);

function buildServer(userId, apiKeyId) {
  const server = new McpServer(
    { name: 'tradejournal-backtest', version: '1.0.0' },
    {
      instructions: [
        'Backtest trading strategies on historical candles from the journal owner\'s cTrader account, bar by bar.',
        NO_HINDSIGHT,
        'Typical loop: start_session -> read candles (get_indicators for EMA/RSI/ATR/Bollinger) -> step until a setup forms -> open_trade at market, or place_order for a limit/stop entry -> step with a large bars value (stopOnTradeExit stops at the exit), moving the stop with modify_trade if the rules say so -> log_trade -> repeat. Finish with end_session and get_metrics.',
        'You can also work with the whole Backtest Log: list_backtests and get_backtest read every logged backtest (the owner\'s and agents\'), update_backtest edits journal fields such as notes and lessons, and get_metrics breaks results down by strategy, symbol, direction, weekday, hour, month, timeframe or source.',
        'Prefer step with bars/untilPrice/untilTime over one call per candle: calls are rate limited.',
        'Use blind: true on start_session to test without knowing the date (the server picks a random window, shifts dates and rescales prices), so memory of what the market did cannot leak into decisions.',
        'Trades you log are marked as agent runs and kept apart from the owner\'s own backtest statistics.',
      ].join(' '),
    },
  );
  const tool = (name, title, description, inputSchema, fn) => server.registerTool(name, { title, description, inputSchema }, toolResult(fn));

  tool('list_symbols', 'List symbols', 'Tradable symbol names on the connected cTrader account. Pass search to filter (e.g. "XAU", "EUR").',
    { search: z.string().optional() },
    ({ search }) => replay.listSymbols(userId, search));

  tool('list_strategies', 'List strategies', 'The owner\'s backtest strategies with their descriptions (read these as the rules to follow) and results of agent runs so far.',
    {},
    () => replay.listStrategies(userId));

  tool('create_strategy', 'Create strategy', 'Create a strategy (or update its description) so sessions and logged trades can be filed under it.',
    { name: z.string().max(60), description: z.string().max(500).optional() },
    args => replay.createStrategy(userId, args));

  tool('start_session', 'Start replay session',
    `Start a bar-by-bar replay. The clock starts at "from"; you get the last "context" closed candles before it. ${NO_HINDSIGHT} `
    + 'Pass blind: true (with lengthDays, and optionally from/to as the pool to pick from) to have the server choose a hidden random window: dates are then shifted (weekday and time of day stay real) and prices rescaled. '
    + 'Tag the session with a strategy so logged trades are filed under it. At most 10 active sessions.',
    {
      symbol: z.string().describe('Symbol as listed by list_symbols, e.g. XAUUSD.'),
      interval: timeframe.default('15min').describe('Timeframe the replay steps in.'),
      from: timeInput.optional().describe('Start (ISO date/time or unix seconds). Required unless blind.'),
      to: timeInput.optional().describe('End, in the past. Required unless blind.'),
      strategy: z.string().optional(),
      context: z.number().int().min(0).max(500).default(100).describe('Closed candles to return from before the start.'),
      blind: z.boolean().default(false),
      lengthDays: z.number().int().min(1).max(365).optional().describe('Blind sessions: how many days to replay (default 30).'),
    },
    args => replay.startSession(userId, apiKeyId, args));

  tool('get_candles', 'Get candles',
    `Closed candles before the clock on any timeframe, newest last. On a timeframe higher than the session's, the current still-forming candle is appended (forming: true), built only from revealed data. ${NO_HINDSIGHT} Use "before" to page further back.`,
    {
      sessionId,
      timeframe: timeframe.optional().describe('Defaults to the session timeframe.'),
      count: z.number().int().min(1).max(500).default(100),
      before: timeInput.optional().describe('Only candles closing at or before this time (as shown in earlier results).'),
    },
    ({ sessionId: id, ...args }) => replay.getCandles(userId, id, args));

  tool('step', 'Step the replay',
    'Reveal the next candles in the session timeframe, resolving any open trade against each one (a candle touching both stop and target is settled on smaller candles, down to 1 minute; if still ambiguous, the stop). '
    + 'Without bars/untilPrice/untilTime it reveals one candle. To avoid one call per candle: pass bars (up to maxBars), untilPrice (stop on the candle that trades through it) or untilTime; '
    + 'with stopOnTradeExit (default true) it stops as soon as an open trade exits or a pending order expires. Returns the revealed candles (last 200), events (order_filled, order_expired, trade_closed, price_reached, time_reached, session_end) and the session state.',
    {
      sessionId,
      bars: z.number().int().min(1).max(5000).optional(),
      untilPrice: z.number().optional(),
      untilTime: timeInput.optional(),
      stopOnTradeExit: z.boolean().default(true),
      maxBars: z.number().int().min(1).max(5000).default(2000),
    },
    ({ sessionId: id, ...args }) => replay.step(userId, id, args));

  tool('set_timeframe', 'Set timeframe', 'Change the timeframe the replay steps in. The clock does not move.',
    { sessionId, timeframe },
    ({ sessionId: id, timeframe: tf }) => replay.setTimeframe(userId, id, tf));

  tool('get_state', 'Get session state', 'Clock, progress, last candle, the open trade with unrealised R, and any closed trade waiting to be logged.',
    { sessionId },
    ({ sessionId: id }) => replay.getState(userId, id));

  tool('open_trade', 'Open trade',
    'Enter at the close of the last revealed candle. The stop is required and must be on the losing side of entry; the target is optional. One trade at a time per session, and a closed trade must be logged or discarded first.',
    {
      sessionId,
      direction: z.enum(['long', 'short']),
      stopLoss: z.number(),
      takeProfit: z.number().optional(),
      riskAmount: z.number().positive().default(100).describe('USD risked; P&L is R multiple x this.'),
    },
    ({ sessionId: id, ...args }) => replay.openTrade(userId, id, args));

  tool('close_trade', 'Close trade', 'Exit the open trade at the close of the last revealed candle.',
    { sessionId },
    ({ sessionId: id }) => replay.closeTrade(userId, id));

  tool('discard_trade', 'Discard trade', 'Drop the closed trade without logging it.',
    { sessionId },
    ({ sessionId: id }) => replay.discardTrade(userId, id));

  tool('log_trade', 'Log trade',
    'Record the closed trade in the owner\'s Backtest Log under the session strategy, marked as an agent run. Explain the setup in notes so the owner can review it.',
    {
      sessionId,
      name: z.string().max(100).optional(),
      notes: z.string().max(5000).optional().describe('Why the trade was taken, per the strategy rules.'),
      lesson: z.string().max(2000).optional(),
      setupQuality: z.number().int().min(0).max(5).optional(),
      executionQuality: z.number().int().min(0).max(5).optional(),
      planFollowed: z.boolean().optional(),
      mistakes: z.array(z.string()).max(10).optional(),
      tags: z.array(z.string()).max(9).optional().describe('Extra tags; the session strategy always comes first.'),
    },
    ({ sessionId: id, ...args }) => replay.logTrade(userId, id, args));

  tool('list_sessions', 'List sessions', 'Your 20 most recently used replay sessions.',
    {},
    () => replay.listSessions(userId));

  tool('end_session', 'End session', 'Finish a session. An open or unlogged trade is dropped, so log it first if it counts.',
    { sessionId },
    ({ sessionId: id }) => replay.endSession(userId, id));

  tool('place_order', 'Place pending order',
    'Place a limit order (enter on a pullback to a better price) or stop order (enter on a breakout) instead of entering at market. It fills when a later candle trades through its price, settled on 1-minute candles; a gap fills at the open. In the fill minute only the stop is checked (the conservative reading). Optional expiry.',
    {
      sessionId,
      type: z.enum(['limit', 'stop']),
      direction: z.enum(['long', 'short']),
      price: z.number(),
      stopLoss: z.number(),
      takeProfit: z.number().optional(),
      riskAmount: z.number().positive().default(100),
      expiresAfterBars: z.number().int().min(1).max(5000).optional().describe('Cancel if not filled within this many bars of the session timeframe.'),
      expiresAt: timeInput.optional().describe('Or cancel at this time.'),
    },
    ({ sessionId: id, ...args }) => replay.placeOrder(userId, id, args));

  tool('cancel_order', 'Cancel pending order', 'Cancel the pending limit/stop order.',
    { sessionId },
    ({ sessionId: id }) => replay.cancelOrder(userId, id));

  tool('modify_trade', 'Modify trade or order',
    'Move the stop and/or target of the open trade (e.g. stop to breakeven, trailing), or the price/stop/target of a pending order. Stops and targets must stay on the correct side of the current price. R is always measured from the original stop.',
    {
      sessionId,
      stopLoss: z.number().optional(),
      takeProfit: z.number().optional(),
      removeTakeProfit: z.boolean().optional().describe('Drop the target and let the trade run to its stop or a manual close.'),
      price: z.number().optional().describe('Pending orders only: new entry price.'),
    },
    ({ sessionId: id, ...args }) => replay.modifyTrade(userId, id, args));

  tool('get_indicators', 'Get indicators',
    `Indicator values on closed candles before the clock, newest last: ema:<period>, sma:<period>, rsi:<period>, atr:<period>, bb:<period>:<stddev>. ${NO_HINDSIGHT}`,
    {
      sessionId,
      timeframe: timeframe.optional().describe('Defaults to the session timeframe.'),
      indicators: z.array(z.string()).max(10).default(['ema:20', 'ema:50', 'rsi:14', 'atr:14']),
      count: z.number().int().min(1).max(500).default(50),
    },
    ({ sessionId: id, ...args }) => replay.getIndicators(userId, id, args));

  const logFilters = {
    source: z.enum(['agent', 'replay', 'quick', 'all']).optional().describe('agent = logged through these tools; replay = the owner\'s chart backtests; quick = the owner\'s quick logs.'),
    strategy: z.string().optional(),
    symbol: z.string().optional(),
    direction: z.enum(['long', 'short']).optional(),
    from: timeInput.optional().describe('Trades entered at or after this date.'),
    to: timeInput.optional().describe('Trades entered before this date.'),
  };

  tool('list_backtests', 'List backtests',
    'Browse the Backtest Log: the owner\'s own backtests and agent runs, with filters. Rows include results and journal scores; use get_backtest for notes and the chart snapshot. Blind-session trades hide their real dates and prices.',
    {
      ...logFilters,
      source: logFilters.source.default('all'),
      outcome: z.enum(['win', 'loss', 'breakeven']).optional(),
      sort: z.enum(['newest', 'oldest', 'best', 'worst']).default('newest').describe('newest/oldest = by when it was logged; best/worst = by R.'),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    },
    args => backtestLog.listBacktests(userId, args));

  tool('get_backtest', 'Get backtest',
    'One backtest in full: prices, times, result, notes, lesson, mistakes and quality scores, plus the chart snapshot image saved with it (when there is one).',
    { id: z.string(), includeSnapshot: z.boolean().default(true) },
    async ({ id, includeSnapshot }) => {
      const { backtest, snapshot } = await backtestLog.getBacktest(userId, id, { includeSnapshot });
      return snapshot ? { backtest, images: [snapshot] } : { backtest };
    });

  tool('update_backtest', 'Update backtest journal',
    'Edit a backtest\'s journal fields (any backtest, including the owner\'s): name, strategy or tags, notes (replace) or appendNotes (add a paragraph, keeping what is there), lesson, planFollowed, setupQuality/executionQuality (0-5), mistakes. Prices and results cannot be changed. Prefer appendNotes on the owner\'s trades so their own words are kept.',
    {
      id: z.string(),
      name: z.string().max(100).optional(),
      strategy: z.string().optional(),
      tags: z.array(z.string()).max(10).optional(),
      notes: z.string().max(5000).optional(),
      appendNotes: z.string().max(5000).optional(),
      lesson: z.string().max(2000).optional(),
      planFollowed: z.boolean().optional(),
      setupQuality: z.number().int().min(0).max(5).optional(),
      executionQuality: z.number().int().min(0).max(5).optional(),
      mistakes: z.array(z.string()).max(10).optional(),
    },
    ({ id, ...args }) => backtestLog.updateBacktest(userId, id, args));

  tool('delete_backtest', 'Delete backtest', 'Delete a backtest that an agent logged. The owner\'s own backtests cannot be deleted from here.',
    { id: z.string() },
    ({ id }) => backtestLog.deleteBacktest(userId, id));

  tool('delete_strategy', 'Delete strategy', 'Delete a strategy definition (its name and description). Backtests logged under it keep their tag.',
    { name: z.string() },
    ({ name }) => backtestLog.deleteStrategy(userId, name));

  tool('get_metrics', 'Get metrics',
    'Statistics from the Backtest Log, the same as the Metrics page: trades, win rate, expectancy and average/total R, average win/loss, payoff, profit factor, max drawdown in R, best/worst, streaks, SQN, half Kelly and P&L. '
    + 'Filter by source (default: agent runs only), strategy, symbol, direction and date; break down by any of strategy, symbol, direction, timeframe, source, outcome, weekday, hour (UTC) or month. Use source: all with groupBy: source to compare the owner\'s results with the agent\'s.',
    {
      ...logFilters,
      source: logFilters.source.default('agent'),
      groupBy: z.array(z.enum(['strategy', 'symbol', 'direction', 'timeframe', 'source', 'outcome', 'weekday', 'hour', 'month'])).max(4).default(['strategy']),
    },
    args => backtestLog.getMetrics(userId, args));

  return server;
}

router.post('/mcp', agentAuth, limiter, async (req, res) => {
  const server = buildServer(req.user.userId, req.apiKey._id);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

// Stateless server: no standalone SSE stream and no sessions to delete.
const methodNotAllowed = (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
router.get('/mcp', methodNotAllowed);
router.delete('/mcp', methodNotAllowed);

module.exports = router;
