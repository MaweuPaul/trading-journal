# Known bugs

Found while connecting Claude to the MCP endpoint and reviewing the journal's
trades through it (September 2026). Newest first within each section.

## Open

### No stop loss recorded on any trade
- **Where:** `backend/lib/ctraderSync.js` (sets `stopLoss: null` for every
  cTrader trade) and the MT5 upload path in `backend/routes/trades.js`
  (stores `null` when the EA sends 0).
- **Symptom:** 0 of 312 trades have a stop, so `r`, `riskUSD` and every
  R-based metric are empty.
- **Status:** partly fixed (October 2026).
  - **cTrader:** the sync now reads each position's opening stop from order
    history (`ProtoOAOrderListReq`), works out `riskUSD`/`riskPercent`, and on
    its first run fills in every trade synced before this. Not yet checked
    against the live account's real order history.
  - **Any trade:** a stop loss can be typed in on the Trades page; the risk is
    worked out from it.
  - **MT5:** still open. Check whether the EA sends the position's SL.

## Fixed

### `npm test` ran a script that needs a real database
- **Where:** `backend/scripts/test-orb-ny-open-mcp.js`
- **Symptom:** `node --test` picked it up by name and it always failed without
  a MongoDB URI, so the suite was never fully green locally.
- **Fix:** `npm test` now runs `test/**/*.test.js` only.

### OAuth consent page rejected loopback redirects on another port
- **Where:** `checkClient` in `backend/routes/oauth.js`
- **Symptom:** "The redirect address does not match what this app registered"
  for a client registered with `http://127.0.0.1:8765/callback`. Not
  reproduced exactly, but the check was an exact string match, and desktop and
  CLI apps (Codex, Claude Desktop) listen on whatever port is free.
- **Fix:** loopback redirects (`localhost`, `127.0.0.1`, `[::1]`) match on
  path and query with any port and any loopback spelling (RFC 8252 §7.3).
  Other redirects still match exactly. Covered by a test.

### Lot sizes carried float noise
- **Where:** trade sync (`lotSize` = volume ÷ units per lot).
- **Symptom:** lots like `0.09999999999999999`, which also split "0.1" into
  two groups in lot-size breakdowns.
- **Fix:** the Trade model rounds `lotSize` to 6 decimals on save (micro crypto
  lots stay exact), and the agent tools round trades stored before the fix.

### Account breakdowns split one account into two
- **Where:** `backend/lib/agentJournal.js`, `list_trades` and the `account`
  group in `get_journal_metrics`.
- **Symptom:** `ctrader:48103642` showed as "cTrader Live" (57 trades) and
  "cTrader Live (tradinghive)" (39 trades).
- **Cause:** the account label gained the broker title partway through, and
  older trades kept the name they were synced with.
- **Fix:** trades show their account's current `TradingAccount` label. Covered
  by a test.

### Pre-trade chart showed fewer days than asked on short intervals
- **Where:** `backend/routes/preTradeAnalyses.js`, `GET /pre-trade-analyses/chart`
- **Symptom:** 5 days of 1-minute candles (~7,200 bars) returned only the
  newest 1,500 (about one trading day), silently.
- **Fix:** pages back far enough to cover the window (`getTrendbars` still caps
  it at 14 pages, ~21,000 bars).

### `get_trade_candles` returned candles from days after short trades
- **Where:** `backend/lib/agentJournal.js`, `getTradeCandles`
- **Symptom:** for trades open under 30 minutes (1-minute candles), the tool
  returned ~61 bars starting hours or days *after* the trade, with no bars
  before the entry. 31 of 32 Nasdaq shorts came back this way; only the most
  recent one was right.
- **Cause:** the window is padded by 3 days on each side (~9,000 one-minute
  bars), but `getTrendbars` was called without `maxPages`, so cTrader returned
  only its newest 1,500-bar page, all from after the trade. `entryIdx` then
  fell to 0 and the slice was just the "after" bars. The test harness's
  `getTrendbars` stub ignored the page limit, so the test passed anyway.
- **Fix:** page back far enough to cover the window, and throw `NO_DATA`
  instead of returning candles that don't reach the entry. The harness stub
  now enforces cTrader's 1,500-bar pages, and a regression test covers a
  2-minute trade.
