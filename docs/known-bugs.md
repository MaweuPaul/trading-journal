# Known bugs

Found while connecting Claude to the MCP endpoint and reviewing the journal's
trades through it (September 2026). Newest first within each section.

## Fixed

### `get_trade_candles` returned candles from days after short trades
- **Where:** `backend/lib/agentJournal.js` → `getTradeCandles`
- **Symptom:** for trades open under 30 minutes (1-minute candles), the tool
  returned ~61 bars starting hours or days *after* the trade, with no bars
  before the entry. 31 of 32 Nasdaq shorts came back this way; only the most
  recent one was right.
- **Cause:** the window is padded by 3 days on each side (~9,000 one-minute
  bars), but `getTrendbars` was called without `maxPages`, so cTrader returned
  only its newest 1,500-bar page — all from after the trade. `entryIdx` then
  fell to 0 and the slice was just the "after" bars. The test harness's
  `getTrendbars` stub ignored the page limit, so the test passed anyway.
- **Fix:** page back far enough to cover the window, and throw `NO_DATA`
  instead of returning candles that don't reach the entry. The harness stub
  now enforces cTrader's 1,500-bar pages, and a regression test covers a
  2-minute trade.

## Open

### Pre-trade chart shows fewer days than asked on short intervals
- **Where:** `backend/routes/preTradeAnalyses.js` → `GET /pre-trade-analyses/chart`
- **Symptom:** asking for 5 days of 1-minute candles (~7,200 bars) returns only
  the newest 1,500 (about one trading day), silently.
- **Cause:** same as above — `getTrendbars` called with the default
  `maxPages = 1`.
- **Fix idea:** pass `maxPages: Math.ceil(bars / 1500) + 1`, or cap `days` per
  interval so the window fits one page.

### Account breakdowns split one account into two
- **Where:** `backend/lib/agentJournal.js` — `list_trades` (`account:` field)
  and the `account` group in `get_journal_metrics` use the `accountName` stored
  on each trade at sync time.
- **Symptom:** `ctrader:48103642` shows as "cTrader Live" (57 trades) and
  "cTrader Live (tradinghive)" (39 trades), while `list_journal_accounts`
  reports it as one account with 96 trades.
- **Cause:** the account label gained the broker title partway through (see
  `getOrCreateTradingAccount` in `ctraderSync.js`), and older trades kept the
  old name.
- **Fix idea:** group by `accountKey` and show the current `TradingAccount`
  label, or backfill `accountName` on sync.

### OAuth consent page rejected a loopback redirect that matched
- **Where:** `/oauth/authorize` → `checkClient` in `backend/routes/oauth.js`
- **Symptom:** a client registered with `http://127.0.0.1:8765/callback`, sent
  to the consent page with that exact `redirect_uri`, got "The redirect address
  does not match what this app registered." The same flow with an `https`
  redirect on the app's own domain worked.
- **Status:** not reproduced. `checkClient` is an exact string match and the
  registered and requested values looked identical, so the link may have been
  altered on the way to the browser. Worth retesting with Codex or Claude
  desktop, which use loopback redirects. Note RFC 8252 §7.3 also asks servers
  to accept any port on loopback redirects, which `checkClient` does not.

### No stop loss recorded on any trade
- **Where:** `backend/lib/ctraderSync.js` (sets `stopLoss: null` for every
  cTrader trade) and the MT5 upload path in `backend/routes/trades.js`
  (stores `null` when the EA sends 0).
- **Symptom:** 0 of 312 trades have a stop, so `r`, `riskUSD` and every
  R-based metric are empty.
- **Status:** the cTrader case is a known limitation per the code comment.
  Worth checking whether the entry order's SL can be read from
  `ProtoOAOrderListReq` history. For MT5, check whether the EA sends the
  position's SL.

### Lot sizes carry float noise
- **Where:** trade sync (`lotSize` = volume ÷ units per lot).
- **Symptom:** `list_trades` shows lots like `0.09999999999999999`, which also
  splits "0.1" into two groups in any lot-size breakdown.
- **Fix idea:** round `lotSize` to 2 decimals (or the symbol's volume step)
  when syncing.

### `npm test` runs a script that needs a real database
- **Where:** `backend/scripts/test-orb-ny-open-mcp.js`
- **Symptom:** `node --test` picks it up by name and it always fails without
  a MongoDB URI (`ORB_MCP_ERROR=The uri parameter to openUri() must be a
  string`), so the suite is never fully green locally.
- **Fix idea:** rename it (e.g. `orb-ny-open-mcp.smoke.js`) or point
  `node --test` at `test/` only.
