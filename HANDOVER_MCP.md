# Handover: MCP server so AI agents can backtest a strategy

**Goal.** Let AI agents (Claude Code, Claude Desktop, custom agents) run
backtests on the user's behalf. They replay historical candles bar by bar,
with the future hidden, place simulated trades, and log the results to the
Backtest Log under a strategy.

The user chose:
- **Connection:** a hosted Streamable-HTTP endpoint on the Render backend,
  authenticated with a per-user access key.
- **Scope:** the full tool set described below, not a read-only first version.

---

## 0. Status: built (sections 3.1–3.4), with these changes to the plan

Everything in section 3 is implemented. Section 3 below still describes the design; these are the deliberate differences from it:

- **Agent trades stay out of the owner's stats by default.**
  - Frontend: `BacktestProvider` (`components/backtest/data.tsx`) has an `agentRuns` view: `mine` (default), `agent` or `all`, stored in localStorage.
    - `trades` is the filtered list every view computes from; `allTrades` is everything, used by the detail page and for `#BT-` numbering.
    - The switch (`components/backtest/AgentRuns.tsx`) sits in the desktop Backtest header and at the top of the mobile Log. It only appears once an agent has logged something.
    - This replaces the planned "Hide agent runs" toggle.
  - Backend: `GET /api/backtest-strategies` excludes agent trades from `trades`/`winRate`/`avgR` and reports them separately as `agentTrades`/`agentWinRate`/`agentAvgR`.
- **Blind mode** (`start_session { blind: true, lengthDays, from?, to? }`).
  - The server picks a random window (default pool: the last 6 years).
  - Times are shifted by whole weeks into 1990, so weekday and time of day stay real.
  - Prices are scaled by a random factor (0.5–0.85 or 1.2–2.0).
  - Agent inputs are mapped back to real values. Stored data is always real.
  - Stored in `AgentReplaySession.blind`; logged trades get `BacktestTrade.blind = true`, a "(blind)" name suffix and an AGENT · BLIND badge.
- **Load caps.**
  - At most 10 active sessions per user.
  - cTrader candle fetches run one at a time per user, at most 40 per minute (error code `RATE_LIMITED`).
  - The candle cache fetches gaps in aligned 3000-bar blocks, so step-by-step replay rarely refetches. It holds about 600k candles, evicting least recently used.
  - The MCP route is limited to 120 requests per minute per key.
- **Other changes.**
  - `get_candles` takes `before` to page further back.
  - `step` reveals one bar when no `bars`/`untilPrice`/`untilTime` is given. With only an until-condition, it runs up to `maxBars`.
  - A stop/target is only checked against price after the previous clock. A candle that opened before it (after a timeframe switch) is settled on smaller candles.
  - The tag helpers (`normalizeTags`, `strategyAndTags`) moved to `backend/lib/backtestTags.js`.

**Verified, without a live cTrader connection or database** (the sandbox couldn't reach MongoDB downloads). These checks now live in `backend/test/agentReplay.test.js` and `backend/test/mcpRoute.test.js` (run `npm test` in `backend/`), using the stub harness in `backend/fixtures/agentReplayHarness.js`:
- Tested the engine against a synthetic candle feed. 60 trades, including ones across timeframe switches, all resolved the same way as a brute-force walk of the 1-minute data.
- No returned candle ever closed after the clock. Forming candles were built only from revealed data.
- Blind mode and the session guards behaved as expected.
- Over HTTP, directly and through the Next.js `/api/[...path]` proxy: `initialize`, `tools/list` (15 tools) and `tools/call` work.
- Keys get 401 on `/api/backtest-trades` and `/api/api-keys`. JWTs get 401 on `/api/mcp`. Keys in the URL are rejected, and revoked keys get 401.
- The UI renders at desktop and phone widths.

**Still to do: step 3.5.2 against the real local stack** (test database plus a connected cTrader).
1. Create a key on the Accounts page.
2. Run `claude mcp add ...`.
3. Run a session end to end and confirm the AGENT badge in the Log.

---

## 1. Repo and conventions (read first)

**Layout**
- Monorepo: `frontend/` (Next.js App Router) and `backend/` (Express + Mongoose, CommonJS).
- **Browser → backend traffic** goes through `frontend/app/api/[...path]/route.ts`. That proxy forwards `/api/*` to `BACKEND_API_URL` (default `http://localhost:4000/api`).
  - Mount MCP at **`/api/mcp`**, so the public URL is `<frontend-origin>/api/mcp`.
  - The proxy forwards the `Authorization` header. It already handles POST bodies and passes the response body through.

**Backend patterns**
- **Routes:** `backend/routes/*.js`, mounted in `backend/server.js` with `app.use('/api', router)`.
- **Per-route guards:** each file defines its own `ownerOnly` and `isOffline` helpers (see `routes/backtestTrades.js`).
- **Auth:** `backend/middleware/auth.js` verifies a **JWT** and puts `{ userId, role }` on `req.user`.
  - Access keys must NOT be JWTs. That way they're automatically rejected everywhere except the MCP route.
- **Candles:** `backend/lib/ctraderReplay.js` → `getTrendbars({ userId, symbol, periodLabel, fromMs, toMs, maxPages })`.
  - `periodLabel` is one of `1min 5min 15min 1h 4h 1day`.
  - It pages cTrader 1500 bars per request up to `maxPages`; the default of 1 means a single request.
  - Returns `{ candles: [{ time (unix s, open time), open, high, low, close, volume }] }`, sorted.
  - Throws `err.code` values: `NOT_CONNECTED`, `NO_ACCOUNT_SELECTED`, `SYMBOL_NOT_FOUND`.
- **Symbols:** `listAccountSymbols({ userId })` in the same file.
- **Backtest data:**
  - `models/BacktestTrade.js` is the Backtest Log. Tags: `strategy` is always `tags[0]`; see `normalizeTags` / `strategyAndTags` in `routes/backtestTrades.js`.
  - `models/BacktestStrategy.js` holds the strategy definitions.
  - `GET /api/backtest-strategies` in `routes/backtestStrategies.js` merges in stats.

**Frontend**
- The Backtest UI is in `frontend/components/backtest/*`. It uses Tailwind v4 with the **`tw:` prefix**, scoped by `app/backtest/backtest.css`. Colour tokens there map to the app's CSS variables in `app/globals.css`.
- Reference implementation of the no-hindsight replay logic: `frontend/components/backtest/Workspace.tsx`. It has:
  - `levelsHit()` and `firstLevelHit()`: stop/target resolution on finer candles, down to 1m.
  - Timeframe switching: close-time clock, and the partial "forming" candle rebuilt from revealed data.
- Candle cache helpers to mirror on the server (`missingRanges`, `addRange`, `mergeCandles`): `frontend/components/backtest-tools/candleCache.ts`.

**Working rules the user expects**
- **Commits:** only when asked. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The user has been committing straight to `main`.
- **Files never committed:** `.claude/launch.json` (local), `BACKTEST_TEST_REPORT.md`, `TradeScreenshot.mq5`.
- **Secrets:** never print values from `backend/.env`.
- **Database:** local dev uses `USE_TEST_DATABASE=true` (database `tradejournal_test`), and the user wants to keep it that way.
- **Checks:** run `npx tsc --noEmit` in `frontend/` and `node --check <file>` for backend files after edits. Most of the lint warnings left in `Workspace.tsx` (React-compiler rules) predate these changes.

---

## 2. Done before this build

- **Packages:** `backend/package.json` gained **`@modelcontextprotocol/sdk@^1.30`** and **`zod@^4`**. SDK 1.30 accepts zod 4 shapes in `registerTool`.
- **`backend/models/ApiKey.js`:**
  - Fields: `user`, `name`, `keyHash` (sha256, unique), `prefix`, `scopes: ['backtest']`, `lastUsedAt`, `revokedAt`.
- **`backend/models/AgentReplaySession.js`:**
  - Session fields: `user`, `apiKey`, `symbol`, `interval`, `fromMs`, `toMs`, **`clock`** (unix s, close time of the last revealed candle), `strategy`, `openTrade`, `closedTrade` (resolved, not yet logged), `loggedTrades`, `status`, and `expiresAt` (TTL index; set it about 7 days after each use).
  - Trade sub-document fields: direction, entryTime (open time of the candle it was placed on), entryPrice, stopLoss, takeProfit, riskAmount, exitTime, exitPrice, exitReason (`stop`, `target` or `manual`), outcome, rMultiple, pnlUSD.
- **`backend/models/BacktestTrade.js`:** `source` enum now includes **`'agent'`**.

---

## 3. Design (now built; see section 0 for changes)

### 3.1 `backend/lib/agentReplay.js`: server-side replay engine

**Core rule:** never return a candle whose close time (`time + tfSec`) is after `session.clock`.

**Timeframes:** `tfSec = { '1min': 60, '5min': 300, '15min': 900, '1h': 3600, '4h': 14400, '1day': 86400 }`.

**Candle cache:** in memory, per process, keyed `userId|symbol|tf`. Store `{ candles, ranges }` and fetch only the gaps via `getTrendbars(..., maxPages: 15)`. Mirror `candleCache.ts`.
- Weekends mean N bars ≠ N × tfSec. When fetching "the next N candles", request about `N * tfSec * 2 + 3 days`, and extend if short.

**Functions** (all take `userId`; load and save the session doc; bump `expiresAt` on every call):

- **`startSession({ symbol, interval, from, to, strategy, context = 100 })`**
  - `clock = fromMs / 1000`.
  - Return the session id plus the last `context` closed candles (maximum 500).
- **`getCandles(session, { timeframe = session.interval, count = 100 })`**
  - Closed candles before the clock, going back in history as far as the agent likes.
  - If `timeframe` is higher than `session.interval`, append the **forming** candle. Build it from `session.interval` candles between the forming candle's open and the clock (open = first, high = max, low = min, close = last). Mark it `forming: true`.
- **`step(session, { bars = 1, untilPrice?, untilTime?, stopOnTradeExit = true, maxBars = 2000 })`**
  - Walk the next candles in `session.interval`: those with `time + tfSec > clock`, in order.
  - For each candle, set `clock = time + tfSec`, then resolve any open trade:
    - Only candles with `time > openTrade.entryTime` count.
    - Long: stop if `low <= stopLoss`, target if `high >= takeProfit`. Short: the mirror image.
    - If **both** are hit, use `firstLevelHit` on finer timeframes (`1day→4h→1h→15min→5min→1min`), bounded to `[max(candle.time, previous clock), candle close)`. If still ambiguous at 1min, assume the stop.
    - On close, fill in `closedTrade` (outcome: `win` for the target; for the stop, `breakeven` if the stop is at or beyond entry in the trade's favour, otherwise `loss`) and clear `openTrade`.
  - Stop early when:
    - the trade exits (if `stopOnTradeExit`),
    - `low <= untilPrice <= high`,
    - `clock >= untilTime`,
    - or the session end is reached.
  - Return:
    - the revealed candles (if more than 200, the last 200 plus a count),
    - events (`trade_closed`, `price_reached`, `time_reached`, `session_end`),
    - the state.
- **`openTrade(session, { direction, stopLoss, takeProfit?, riskAmount = 100 })`**
  - Entry is the last revealed close; `entryTime` is the last revealed candle's open time.
  - Check the stop and target are on the correct side of entry.
  - Refuse if a trade is already open, or if an unlogged `closedTrade` exists (tell the agent to call `log_trade` or `discard_trade`).
- **`closeTrade(session)`:** exit at the last revealed close; `exitReason: 'manual'`; R computed from the stop distance.
- **`discardTrade(session)`:** drop `closedTrade`.
- **`logTrade(session, { name, notes, lesson, setupQuality, executionQuality, planFollowed, mistakes, tags })`:** create a `BacktestTrade` with `source: 'agent'` and strategy/tags from the session strategy plus `tags`. Increment `loggedTrades`, clear `closedTrade`, and return the created trade's id.
- **`setTimeframe(session, tf)`:** change `session.interval` and keep `clock`.
- **`getState(session)`:** symbol, timeframe, clock as ISO, session range and progress %, the last candle, the open trade with unrealised R, the closed trade.
- **`listSessions()`**, **`endSession(session)`**.
- **`getMetrics({ strategy?, source? })`:** from `BacktestTrade`: n, wins, losses, winRate, avgR, totalR, profit factor, expectancy, max drawdown in R, broken down by strategy.

### 3.2 `backend/routes/apiKeys.js`: key management, protected by the normal JWT `auth`

- `GET /api/api-keys` lists keys: name, prefix, createdAt, lastUsedAt, revoked. Never return the hash.
- `POST /api/api-keys { name }` generates `'tjk_' + crypto.randomBytes(32).toString('base64url')`, stores its sha256, and returns the **plaintext once**.
- `DELETE /api/api-keys/:id` sets `revokedAt`.
- Use `ownerOnly` and `isOffline` like the other route files.

### 3.3 `backend/routes/mcp.js`: `POST /api/mcp`

- **Auth middleware:** read `Authorization: Bearer tjk_…`, sha256 it, find a non-revoked `ApiKey`, and set `req.user = { userId: key.user, role: 'agent' }` and `req.apiKey = key`. Update `lastUsedAt` at most once a minute. Return 401 otherwise.
- **Never accept the key in the URL:** `morgan` logs URLs.
- **Rate limit** with `express-rate-limit`, which is already a dependency: about 120 requests per minute per key.
- **Stateless Streamable HTTP**, one server per request:

  ```js
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  router.post('/mcp', agentAuth, limiter, async (req, res) => {
    const server = buildServer(req.user.userId, req.apiKey._id);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  router.get('/mcp', (req, res) => res.status(405).end());
  router.delete('/mcp', (req, res) => res.status(405).end());
  ```

- **Tools**, registered with `server.registerTool(name, { title, description, inputSchema: { …zod } }, handler)`:
  - `list_symbols(search?)`, `list_strategies()`, `create_strategy(name, description?)`
  - `start_session`, `get_candles`, `step`, `set_timeframe`, `get_state`
  - `open_trade`, `close_trade`, `discard_trade`, `log_trade`
  - `list_sessions`, `end_session`, `get_metrics`
- **Return values:** `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`. For errors, the same with `isError: true` and a plain message, including the cTrader setup codes.
- **Tool descriptions** should state the no-hindsight rule, and that `step` with `untilPrice`/`stopOnTradeExit` avoids one call per bar.
- **Mounting:** in `server.js`, mount `routes/apiKeys.js` and `routes/mcp.js` with `app.use('/api', …)` before `tradesRouter`.

### 3.4 Frontend

- **Access keys UI:** a new `frontend/components/AgentKeys.tsx` card on the Accounts page (`frontend/app/accounts/page.tsx`).
  - List, create and revoke keys.
  - After creating a key, show it once with a copy button, plus the connection command:

    ```
    claude mcp add --transport http tradejournal <window.location.origin>/api/mcp --header "Authorization: Bearer <key>"
    ```

  - Note that claude.ai web custom connectors would need OAuth, which is not built. Claude Code, Claude Desktop and custom agents work with the header.
- **Backtest Log** (`components/backtest/LogView.tsx`):
  - Add an **AGENT** badge for `source === 'agent'`, next to where the `quick` / MANUAL badge renders.
  - Add a "Hide agent runs" toggle to the filters.
  - Add `'agent'` to the `source` union in `components/backtest/data.tsx`.

### 3.5 Verify

1. `node --check` all new backend files, and `npx tsc --noEmit` in `frontend/`.
2. With the local dev servers running (backend `:4000`, frontend `:3000`, cTrader connected in the test database):
   - Create a key in the UI.
   - Run `claude mcp add --transport http tradejournal http://localhost:3000/api/mcp --header "Authorization: Bearer <key>"`, or send JSON-RPC by hand with `curl` (`initialize`, then `tools/list`, then `tools/call`).
   - Run: start a session, get candles, step, open a trade, step with `stopOnTradeExit`, log the trade.
   - Confirm the logged trade appears in the Backtest Log with the AGENT badge.
3. Check that an access key gets **401** on `GET /api/backtest-trades`, so keys only work for MCP.
4. Check that `get_candles` and `step` never return a candle closing after `clock`.

### 3.6 Deploy notes

- No new environment variables are needed.
- Render runs `npm install` in `backend/`, which picks up the new dependencies.
- The replay clock lives in Mongo, so sessions survive restarts; the in-memory candle cache simply refills.
