# TradeJournal — Self-Hosted MT5 Trading Analytics Portal

A self-hosted, offline-resilient, multi-user trading journal that syncs closed MetaTrader 5 trades, preserves an auditable record of strategy changes, and measures what actually contributes to performance. Anyone can register their own account on an installation — every user's trades, accounts, playbooks, and knowledge base are fully isolated from every other user's.

> New installation? Follow the complete [Setup Guide](SETUP.md). Validating an installation? Use the [Feature Testing Guide](TESTING.md).

## Features

| Feature | Description |
|---|---|
| Automatic MT5 Sync | Python script polls one or more MT5 terminals and sends closed deals and account events to the backend |
| Multi-Account, Multi-Broker | Connect several MT5 logins and several cTrader connections (even under different cTrader accounts) side by side; every page can filter to a single account or blend them with a clear warning |
| cTrader Sync & Replay | OAuth-connect one or more cTrader accounts to sync their trade history and cash flow alongside MT5, and to supply Trade Replay's real historical candles |
| Broker Account Filtering | Detects Live/Demo mode plus the exact login/broker (or cTrader broker name), then filters trades by either dimension everywhere in the app |
| Investor Access | Share a read-only, no-login view of one account's performance — modeled on MT5's own investor password: a stable account number plus a rotatable, instantly revocable password |
| Dashboard | Account balance, equity curve, cash-flow-adjusted growth, and headline metrics |
| Light/Dark Appearance | Choose Auto, Light, or Dark from the sign-in screen or sidebar; Auto follows the device setting and the choice persists across refreshes |
| Performance | Equity curve, drawdown, profit factor, expectancy, and R:R metrics |
| Trading Calendar | Daily P&L heatmap with trade drill-down, per-day average R-multiple, a weekly P&L rollup strip, and its own account filter |
| Analytics | Breakdowns by session, symbol, emotion, grade, weekday, setup, and tags |
| Visual Strategy Playbooks | Build a complete strategy manual from lifecycle stages, detailed fields, and captioned chart evidence |
| Structured Trade Review | Complete Plan, Manage, and Review fields against the exact immutable playbook version used |
| Edge Coach Evidence | Compare versions, stage compliance, structured answers, and numeric fields by outcome and sample size |
| Screenshot Uploads | Attach chart screenshots with Cloudinary hosting and embedded recovery metadata |
| Screenshot Reconstruction | Reattach images or recreate a missing core trade from metadata stored on its screenshot asset |
| Trade Replay | Request exact historical candles from a connected cTrader Open API account, cache them briefly, and replay price action |
| Offline Screenshots | Stage screenshots on disk while MongoDB is unavailable and upload them after reconnection |
| Data Export | Download full JSON backups and flat CSV exports from the Backup page |
| Automatic Backup | Mirror MongoDB into local JSON every 24 hours and on startup |
| Offline Resilience | Fall back to local JSON when MongoDB is unavailable |
| Multi-User, Fully Isolated | Anyone can register their own account; every trade, connection, playbook, and knowledge base entry is scoped to the user who owns it |
| Private by Design | Trade routes require authentication, every MT5 sync agent is tied to one specific user's own secret, and investor sessions are locked to one account with no write access |

## Versioned Strategy Playbooks

Playbooks use an append-only audit model:

1. Create a strategy from an empty canvas or editable lifecycle templates.
2. Arrange stages from Strategy Concept through Context, Setup, Entry, Risk, Execution, Management, Exit, and Review.
3. Add custom fields with guidance, units, defaults, choices, and validation.
4. Add captioned reference, valid, and invalid chart screenshots to a stage or directly to an individual rule; rules may require one or several instructional examples before publishing.
5. Publish the strategy to create an immutable schema-versioned snapshot.
6. Read the published version as a visual book from `/rules/read`.
7. Complete the attached playbook in the trade journal's Plan, Manage, and Review timeline.
8. Publish later revisions as new versions; earlier versions and attached trades remain unchanged.
9. Use Edge Coach to compare versions, lifecycle compliance, structured answers, and numeric-field outcomes.

Removing a rule only excludes it from the next published version. Previous versions and attached trades retain the original rule. Archiving a playbook hides it from new selections without deleting its audit history.

Existing flat trading rules are migrated into a starter playbook automatically.

### How playbook rules generate the trade journal

The trade journal is derived from the selected published playbook rather than from a fixed form:

1. Each playbook stage contains rules with answer configuration, help text, validation, and instructional examples.
2. The rule editor exposes five primitive answer types: Yes/No, Number, Text, Single choice, and Multiple choice. Percentage, Currency, Price, Duration, R:R, and Rating are Number formats; Long explanation, Date, and Time are Text formats.
3. The editor keeps each rule compact and places strategy logic, guidance, validation, formats, and visual references under **More options**. Instructional reference images are always optional.
4. Strategy logic gives every rule a purpose—Observation, Confirmation, Entry trigger, Decision gate, Invalidation, Risk limit, Management action, Exit signal, or Review prompt—plus an optional timeframe scope and an explicit response when the condition is not satisfied.
5. Leaving timeframe scope empty means the rule applies everywhere. A scoped rule displays its timeframes in the reader, trade journal, and Replay; its saved answer still belongs to the immutable rule rather than to the currently viewed chart timeframe.
6. Enable **Require a trade screenshot** only when the journal must collect visual evidence from the actual trade. This requirement is independent of optional teaching references and exposes minimum and maximum trade-screenshot controls.
7. Publishing freezes the complete rule structure, decision behavior, answer configuration, example images, captions, and ordering.
8. Selecting a playbook on an unattached trade generates the Plan, Manage, and Review sections from that version, including decision guidance and a trade-screenshot uploader beneath every rule that requires trade evidence.
9. The first save permanently attaches the complete snapshot to the trade.
10. The journal's answers can be corrected later, but its strategy and version cannot be replaced.
11. Publishing a newer playbook version affects only trades that attach that newer version.

This creates a reliable audit chain: the rule teaches what to look for, its images demonstrate the condition, the trade records whether it happened, and Edge Coach compares that answer with the outcome.

### Edge Coach Evidence

For playbook-backed trades, Edge Coach reports:

- Trade count, win rate, and average P&L for each strategy version.
- Outcomes grouped by each structured rule answer.
- Evidence labels based on sample size: insufficient (`<5`), developing (`5–19`), and strong (`20+`).

Boolean, single-choice, multiple-choice, and rating answers feed answer-group comparisons. Number, percentage, currency, price, duration, risk-to-reward, and rating fields also feed numeric winning-versus-losing averages. Text remains preserved as qualitative audit evidence.

## Live and Demo Accounts

`sync.py` reads `account_info().trade_mode` from the connected MT5 terminal:

- Real accounts are stored as `accountType: "live"`.
- Demo and contest accounts are stored as `accountType: "demo"`.
- Every trade also stores the MT5 login, broker server, account name, and a stable account key (`mt5:<id>` for MT5, `ctrader:<ctidTraderAccountId>` for cTrader).
- A full resync backfills both the type and exact account identity onto matching older trades.
- Every analytics page (Dashboard, Trades, Calendar, Stats, Performance) can filter independently by Live/Demo and by the exact broker account, and the selection persists across navigation. Viewing "All accounts" shows a warning banner whenever the blended data spans more than one account.
- Deal tickets are deduplicated within each account, so two connected accounts may safely contain the same broker ticket number.

Set `MT5_REQUIRE_REAL_ACCOUNT=true` if the sync process must reject every non-real account. Leave it `false` to sync and compare both account types.

### Multiple accounts, multiple brokers

Both MT5 and cTrader support more than one connected account at once:

- **MT5** — add each account from the Accounts page; `sync.py` loads every enabled account and switches the local terminal between them in turn.
- **cTrader** — authorize as many times as needed, even under different cTrader logins (e.g. one personal, one for a partner). Each selected account gets its own row, its own OAuth token, and its own sync/Replay behavior; disconnecting one never affects the others. Account labels are disambiguated by broker name (e.g. "cTrader Live (FxPro)" vs. "cTrader Live (tradinghive)") so two live accounts never look identical in the filter dropdown.

cTrader accounts are OAuth-connected, not credential-based, so they can't be edited like an MT5 login — only connected, resynced, or disconnected.

## Investor Access

Share one account's performance with someone who has no login on this app — no share link, no invite email, just an account number and a password, the same way MT5 itself separates a full-control master password from a view-only investor password:

1. On the Accounts page, open **Investor** on the account to share and click **Enable investor access**. This generates a stable account number and a one-time password — the password is shown exactly once and can never be recovered afterward, only rotated.
2. Send the investor the login link (prefills the account number) and the password through separate channels.
3. They sign in at `/investor/login` with no account of their own and land on a read-only dashboard: balance, net P&L, win rate, profit factor, drawdown, equity curve, and a trade list limited to financial fields — no notes, emotions, screenshots, or checklists. Each trade also has its own **Replay** button, opening the same real historical candles the owner's Trade Replay chart shows (with entry/exit markers) in a stripped-down, view-only chart — no annotations, timeline, or journal panel, since those carry private review content.
4. **Rotate password** issues a new password without changing the account number a saved link points to. **Revoke access** disables it instantly — even an already-issued, unexpired session is locked out on its very next request, because every investor request re-checks the live database rather than trusting the token alone.

Investor sessions are scoped by JWT to exactly three read-only endpoints (summary, trade list, and per-trade replay) and one account; they cannot reach any owner route, regardless of what the token contains.

## Data Redundancy and Reconstruction

The journal stores data across several recovery layers:

```text
1. MongoDB Atlas          — primary database
2. local_trades.json      — local mirror refreshed on startup and every 24 hours
3. Cloudinary image       — screenshot plus core trade context metadata
4. Cloudinary sidecar     — raw JSON with the richer journal and playbook audit record
5. Offline disk cache     — staged image and .meta.json files while MongoDB is offline
6. Manual exports         — JSON and CSV downloads from /archive
```

### Screenshot Metadata

Every Cloudinary screenshot stores:

- Core context including `dealId`, `positionId`, symbol, direction, prices, size, P&L, timestamps, balance, account type, grade, emotion, and tags.
- A raw `{imageId}_metadata` JSON sidecar containing richer journal fields, execution data, and the playbook version, snapshot, and responses.

`POST /api/maintenance/recover-screenshots` searches the authenticated user's Cloudinary folder. It matches screenshots to trades by `dealId`. If a matching trade is missing, the endpoint can recreate the core MT5 trade from context metadata and attach the screenshot.

> Reconstruction reads metadata attached to the screenshot asset. It does not infer prices or P&L by visually reading chart pixels with OCR.

## Architecture

```text
MetaTrader 5 (one or more terminals)
    -> sync.py switches accounts and polls closed deals + account events
    -> POST /api/sync and /api/sync-account-events

cTrader Open API (one or more OAuth connections)
    -> lib/ctraderSync.js pulls deals + cash flow directly, server-side
    -> lib/ctraderReplay.js serves Trade Replay's historical candles

Express backend (:4000)
    -> MongoDB Atlas primary storage
    -> local JSON offline mirror
    -> Cloudinary screenshot and sidecar storage
    -> AES-256-GCM encrypted broker/OAuth credentials

Next.js frontend (:3000)
    -> JWT-authenticated API proxy
    -> /trades    trade list, filters, journal, and playbook review
    -> /calendar  daily/weekly P&L, R-multiple, account filter
    -> /rules     versioned playbook builder
    -> /rules/read visual published-playbook reader
    -> /coach     behavior and playbook evidence
    -> /accounts  MT5 + cTrader connections, investor access
    -> /archive   backup, export, and recovery controls
    -> /investor/login, /investor  read-only view for a shared account (no owner login)
```

## Tech Stack

- **Frontend:** Next.js 15, React 19, Recharts, Vanilla CSS
- **Backend:** Node.js, Express, Mongoose, JWT, Cloudinary SDK
- **Sync:** Python 3, MetaTrader5 SDK, Requests, python-dotenv
- **Database:** MongoDB Atlas with local JSON fallback
- **Images:** Cloudinary with context metadata and raw JSON sidecars

## Setup

### Create your account

Registration is open — anyone who can reach `/signup` can create their own account, at any time, and each account's data is completely isolated from every other account's. There are two ways to get the first account onto a fresh installation:

1. Leave `SEED_OWNER_ENABLED=false`, start MongoDB and the backend, then open `/signup` and register normally like any other user.
2. Set `SEED_OWNER_ENABLED=true` with `OWNER_NAME`, `OWNER_EMAIL`, and `OWNER_PASSWORD` to have the backend create that first account from environment variables on startup — useful for a scripted deploy. This only ever creates one account (the very first one); every user after that registers through `/signup` regardless of this setting.

Environment seeding is create-only: restarting the backend never overwrites an existing account's name, email, or password.

Every account gets its own personal MT5 sync-agent secret at signup (shown once, and regenerable from the Accounts page) — this is what lets multiple users each run their own local `sync.py` against the same backend without their trades ever landing in someone else's account. See "Live and Demo Accounts" below.

### Backend

```bash
cd backend
npm install
cp .env.example .env
# Fill in the backend variables below
node server.js
```

### Frontend

```bash
cd frontend
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:4000/api" > .env.local
npm run dev
```

### MT5 Sync

```bash
pip install -r requirements.txt
cp .env.example .env
# Fill in the MT5 and journal credentials
python sync.py
```

Use `python sync.py --once` for one sync cycle. A full resync can also be requested from the journal maintenance controls.

### Desktop Sync Agent (optional GUI for MT5 Sync)

Instead of running `sync.py` from a terminal, build the native Windows app:

```bash
cd desktop-py
pip install -r requirements.txt
python build.py
```

Produces `desktop-py/dist/TradeJournal Sync Agent.exe` — a single-file
~30MB app (a native Tkinter GUI, not Electron) with a settings window, tray
icon, and process supervision around `sync.py`. Requires Python 3 on `PATH`
(the app itself doesn't bundle a Python runtime for running `sync.py` —
install it from python.org if `python --version` doesn't resolve).

Run the installer, make sure the backend is already running and reachable,
then on first launch fill in:

- **Backend API URL** — defaults to `http://localhost:4000/api`, correct
  if the backend runs on this same machine. Point it at the backend's real
  reachable address instead if it's deployed elsewhere.
- **Sync secret** — from the **Accounts** page in the journal.

Then **Install/update dependencies** once, then **Start Sync**. See
[`desktop-py/README.md`](desktop-py/README.md) for the full walkthrough.

## Project Structure

```text
backend/
  middleware/auth.js        # JWT auth; also enforces the sync-agent and investor route allowlists
  models/
    Trade.js
    User.js
    AccountEvent.js
    TradingAccount.js       # MT5 credentials + investor access, per account
    CTraderConnection.js    # one row per connected cTrader account
    ReplayJournal.js        # Replay annotations, timeline events, quick review, drafts
    SyncRequest.js
  routes/
    auth.js
    tradingAccounts.js      # MT5 account CRUD + investor-access management
    ctrader.js               # cTrader OAuth, account selection, disconnect, sync
    investor.js               # investor login + the three read-only investor endpoints
    trades.js                 # trades, playbooks, analytics, exports, screenshots, replay
  lib/
    credentialEncryption.js  # AES-256-GCM for MT5 credentials + cTrader OAuth tokens
    ctraderClient.js          # TCP/protobuf client for the cTrader Open API
    ctraderAuth.js             # cTrader OAuth2 flow
    ctraderSync.js               # deal/cash-flow sync -> Trade/AccountEvent
    ctraderReplay.js              # symbol resolution + trendbar fetch for Replay
    tradeMath.js                   # P&L, drawdown, R-multiple math (unit-tested)
  local_trades.json          # generated local trade mirror
  local_account_events.json
  local_playbooks.json       # generated offline playbook storage
  public/screenshots/         # offline screenshot staging area
  test/                        # node:test suite
  server.js
frontend/
  app/
    trades/                # trade list, filters, journal, screenshots, Replay
    calendar/               # daily/weekly P&L, R-multiple, account filter
    rules/                    # versioned strategy playbook builder
    coach/                     # Edge Coach evidence
    stats/                      # analytics breakdowns
    performance/                  # equity and risk metrics
    accounts/                      # MT5 + cTrader connections, investor access
    archive/                        # backup and recovery
    investor/login, investor/       # read-only investor view (no owner login)
  components/
    Sidebar.tsx
    TradeReplayModal.tsx
  hooks/useAccountKeyFilter.ts   # persists the selected account across pages
sync.py
requirements.txt
```

## Key API Endpoints

All routes below require a JWT except where noted. `accountKey` filters (`mt5:<id>` or `ctrader:<id>`) are accepted by every analytics endpoint; omitting it blends every connected account and flags the response as `mixedAccounts`.

### Trades, analytics, and journal

| Endpoint | Method | Description |
|---|---|---|
| `/api/trades` | GET | Paginated trades with `symbol`, `direction`, `accountType`, `accountKey`, `from`, and `to` filters |
| `/api/trade-accounts` | GET | List broker accounts represented in the owner's trades, including counts (feeds every Account filter dropdown) |
| `/api/trades/latest-close` | GET | Return the latest trade time for one account so incremental sync never skips another account's history |
| `/api/trades/:id` | PUT | Update journal data and attach a canonical playbook snapshot |
| `/api/stats` | GET | Headline performance metrics, optionally grouped by setup |
| `/api/performance` | GET | Equity curve, drawdown, and risk metrics |
| `/api/calendar` | GET | Daily P&L, trade count, average R-multiple, and win rate for the month |
| `/api/balance` | GET | Current balance reconstructed from trades + cash flow |
| `/api/account-events` | GET / POST / DELETE | Deposits and withdrawals |
| `/api/coach` | GET | Behavioral, version, and rule-answer analytics |
| `/api/trades/:id/replay` | GET | Fetch cached or fresh historical candles from cTrader for one trade's Replay chart |
| `/api/trades/:id/replay-journal` | GET | Load saved chart annotations for one trade and timeframe |
| `/api/trades/:id/replay-journal/annotations` | PUT | Validate and autosave zones, lines, levels, arrows, text, and image pins for one timeframe |
| `/api/trades/:id/replay-journal/events` | PUT | Validate and autosave the candle-linked trade-event timeline |
| `/api/trades/:id/replay-journal/quick-review` | PUT | Autosave or complete the short process-focused review |
| `/api/trades/:id/replay-journal/draft` | PUT | Autosave unfinished journal answers and Replay position |
| `/api/playbooks` | GET / POST | List playbooks or publish a new strategy |
| `/api/playbooks/evidence` | POST | Upload reusable visual evidence for a draft playbook stage |
| `/api/playbooks/:playbookId` | PUT / PATCH | Publish a new immutable version, or archive/restore a strategy |
| `/api/maintenance/dedupe-trades` | POST | Remove duplicate trades sharing the same broker deal/ticket |
| `/api/maintenance/recalculate-balances` | POST | Rebuild `runningBalance` from trade + cash-flow order |
| `/api/maintenance/recover-screenshots` | POST | Reattach screenshots and reconstruct missing core trades |
| `/api/export/json` / `/api/export/csv` | GET | Full JSON backup or flat CSV export |
| `/api/export/status` | GET | Database, backup, and pending screenshot status |

### Auth and accounts

| Endpoint | Method | Description |
|---|---|---|
| `/api/auth/setup-status` | GET *(public)* | Report whether the one-time owner Signup page is available |
| `/api/auth/register` | POST *(public)* | Create the owner only when the database contains zero users |
| `/api/login` | POST *(public)* | Sign in |
| `/api/sync-agent` | POST *(public)* | Exchange one user's personal sync secret for a short-lived worker token scoped to that user |
| `/api/auth/sync-secret/rotate` | POST | Generate or rotate the caller's own personal sync secret (returned once, in plaintext) |
| `/api/trading-accounts` | GET / POST | List safe summaries or encrypt a new MT5 account |
| `/api/trading-accounts/:id` | PATCH / DELETE | Update, disable, or archive a trading account |
| `/api/trading-accounts/:id/investor-access` | POST / DELETE | Enable or rotate (returns the plaintext password once), or revoke, read-only investor access |
| `/api/sync-agent/trading-accounts` | GET *(sync-agent token)* | Supply decrypted enabled MT5 accounts only, to the local worker |
| `/api/sync` / `/api/sync-account-events` | POST *(sync-agent token)* | Receive MT5 closed trades / cash-flow events |
| `/api/ctrader/auth-url` | GET | Start a cTrader OAuth authorization |
| `/api/ctrader/exchange` | POST | Complete OAuth, list the accounts it can reach |
| `/api/ctrader/select-accounts` | POST | Finalize which of those accounts to connect |
| `/api/ctrader/status` | GET | List the owner's connected cTrader accounts |
| `/api/ctrader/connection/:ctidTraderAccountId` | DELETE | Disconnect one cTrader account |
| `/api/ctrader/sync` / `/api/ctrader/sync/:ctidTraderAccountId` | POST | Sync every connected cTrader account, or just one |
| `/api/investor/login` | POST *(public, rate-limited)* | Exchange an investor account number + password for a scoped read-only token |
| `/api/investor/summary` / `/api/investor/trades` | GET *(investor token)* | Balance, headline stats, equity curve, and a financial-fields-only trade list |
| `/api/investor/trades/:id/replay` | GET *(investor token)* | The same historical candles as owner Replay, sanitized to chart-only fields (no notes/emotion/grade) |

All endpoints require authentication except login and health checks. Export and recovery routes work with the same authenticated user scope as trade routes.

## Environment Variables

### Root `.env` for `sync.py`

| Variable | Description |
|---|---|
| `SYNC_SECRET` | This user's personal sync-agent secret, generated for them at signup (or rotated later from the Accounts page); resolves to their account and no one else's |
| `API_BASE` | Backend API URL, normally `http://localhost:4000/api` |
| `API_TIMEOUT` | HTTP timeout in seconds |
| `SYNC_INTERVAL` | Polling interval in seconds |
| `MT5_REQUIRE_REAL_ACCOUNT` | Legacy fallback for `requireRealAccount`; prefer setting it per-account on the **Accounts** page instead |

MT5 login, password, server, real/demo policy, and symbol aliases are configured on the **Accounts** page. Use the account's **investor (read-only) password**, not the trading/master password — every MT5 account has both, and `sync.py` only ever reads history and balance, never places trades, so the investor password is all it needs. That way, even if a credential were ever exposed, it could only be used to view the account, not trade or withdraw from it. Each credential field is encrypted independently with AES-256-GCM before MongoDB persistence, using an AAD context that includes the owning user's id, so ciphertext from one user's credentials can't be decrypted under another user's context even with the shared master key. JWT authenticates browser and worker sessions; it is not used as encryption. The backend keeps one stable `ACCOUNT_ENCRYPTION_KEY` shared across all users, while each user's local `sync.py` keeps only their own personal `SYNC_SECRET` — the backend looks up the secret's hash to find the matching user, so two users can each run their own `sync.py` against the same installation and their trades will never cross accounts.

The worker loads every enabled account and switches the local MT5 terminal sequentially. Trades and cash-flow events carry the account's opaque database key, so filters and ticket deduplication remain isolated per account. Editing or archiving an account never rewrites its historical trades.

### cTrader-powered trade replay

Trade Replay's candle data comes from the cTrader Open API. cTrader accounts can also sync their own trade history and cash flow into the journal, alongside (not instead of) MT5 — MT5 sync always goes through `sync.py`. Connect from the **Accounts** page: register a free app at [openapi.ctrader.com](https://openapi.ctrader.com), set `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`, and `CTRADER_REDIRECT_URI` in `backend/.env`, then authorize each cTrader account you want candles or trade sync from — one authorization can grant access to several accounts at once, and you choose which to connect. Reconnecting the same account reuses its existing row instead of creating a duplicate. The resulting OAuth tokens are stored encrypted the same way MT5 broker credentials are (`lib/credentialEncryption.js`) and refreshed automatically.

A trade's Replay chart is fetched from whichever connected cTrader account it actually came from (falling back to any connected account for MT5 trades). Resolving the trade's symbol against that account's own symbol list matches common broker suffixes like `XAUUSDm` automatically, plus a small alias table for instruments that are named completely differently across brokers (e.g. `USTEC` ↔ `NASDAQ100`, `BITCOIN` ↔ `BTCUSD`). Trendbars are requested for the needed window and timeframe over a persistent TLS/protobuf connection and returned directly — no background worker or polling queue involved. Results are cached in-process for 30 minutes per trade/timeframe.

Replay supports independently cached `1m`, `5m`, `15m`, `1H`, `4H`, and `1D` views; switching timeframe requests only that interval and preserves the trade's entry/exit timestamps. Its journal panel reads the immutable playbook snapshot already attached to the trade, organizes rules into Plan, Execution, and Review, and saves edited answers without replacing that historical version.

Replay provides TradingView-style documentation tools for zones, trend lines, horizontal levels, arrows, colored text, candle events, and image evidence pinned to an exact time and price. Annotations are stored by trade and timeframe, autosave after changes, reload after refresh, and are included in JSON backups.

Choose **Select** to click an existing chart object. The selected object receives a visible outline and can be removed with the toolbar **Delete** button or the keyboard Delete/Backspace key; **Undo**, individual list deletion, and protected **Clear all** remain available. Image pins reuse the journal screenshot upload pipeline, keep the uploaded evidence attached to the trade, and display a captioned preview on the chart. Static annotations remain hidden until their point anchor or all shape anchors have been revealed, so playback never exposes a future chart note early.

Replay's **Event** tool attaches observations, confirmations, entry/management/exit decisions, emotions, mistakes, rule violations, lessons, or custom events to exact candle time and price. Events can carry importance, notes, emotion, and a rule from the trade's immutable playbook snapshot. The journal timeline autosaves, orders events chronologically, renders chart markers as playback reveals them, and navigates back to an event even when it belongs to another timeframe.

Replay is designed for reviewing the story of a recorded trade, not replacing chart-analysis software. Playback can auto-pause at entry and exit, jump directly to those trade markers, or move between the previous and next journal event. Entry, exit, and decision moments are visible on the scrubber. Keyboard review keeps attention on the chart: Space plays/pauses, arrows step candles, `E`/`X` jump to entry/exit, brackets move between review moments, `Y`/`N` answer plan adherence, `1`–`6` choose emotion, and `A`–`F` set the process grade. Shortcuts never fire while typing in a form field.

Quick Review follows a deliberate sequence. Plan adherence, emotion, the relevant mistake/strength, and the main lesson must be recorded before the process grade unlocks. A non-blocking honesty check flags contradictory combinations such as “did not follow the plan” with an A/B process grade; the trader remains responsible for the final judgment.

Each timeline event also has an explicit visibility scope. **All timeframes** is the default, so a moment logged while reviewing one chart interval doesn't disappear the moment the trader switches to another — the same event is repositioned by timestamp and price as the chart changes. **This timeframe** is available for genuinely chart-specific evidence, such as a 5-minute displacement that has no meaning on a 4-hour candle.

The journal panel opens in **Quick Review** so an ordinary trade can be reviewed in five short answers: plan adherence, primary emotion, the main mistake or repeatable strength, one lesson, and a process grade. Drafts autosave. **Mark Complete & Save** validates the review and mirrors its emotion and grade onto the trade for existing Stats and Edge Coach reports. **Deep Playbook** keeps the full immutable strategy review available when more evidence is warranted.

Replay also keeps an ownership-scoped server draft for unfinished notes, tags, playbook answers, detailed grades, outcome fields, timeframe, revealed candle, speed, and journal phase. The save indicator confirms when it is safe to refresh or close. URL parameters continue to hold shareable navigation state; private journal content is never placed in the URL or local storage.

### `backend/.env`

| Variable | Description |
|---|---|
| `PORT` | Express port, default `4000` |
| `MONGODB_URI` | MongoDB connection string |
| `NODE_ENV` | `development` or `production` |
| `ALLOWED_ORIGINS` | Comma-separated exact frontend origins allowed to call this API (CORS allowlist); defaults to `http://localhost:3000` |
| `SYNC_SECRET` | Installation secret the local `sync.py` worker exchanges for a short-lived sync-agent token |
| `JWT_SECRET` | Long random JWT signing secret |
| `ACCOUNT_ENCRYPTION_KEY` | Separate, stable AES-256-GCM master secret (32+ chars) for encrypting MT5 credentials and cTrader OAuth tokens; changing it makes existing encrypted credentials unreadable |
| `SEED_OWNER_ENABLED` | Set `true` to create the first owner from environment variables |
| `OWNER_NAME` | Owner name used only during first-time environment seeding |
| `OWNER_EMAIL` | Owner email used for seeding and optional offline login |
| `OWNER_PASSWORD` | Owner password used only for first-time seeding and the offline login fallback; minimum 8 characters. Prefer `OWNER_PASSWORD_HASH` (a bcrypt hash) so the real password is never stored in plaintext |
| `OWNER_PASSWORD_HASH` | Bcrypt hash of the owner password; wins over `OWNER_PASSWORD` when both are set |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |
| `CTRADER_CLIENT_ID` | cTrader Open API app Client ID (from [openapi.ctrader.com](https://openapi.ctrader.com)) |
| `CTRADER_CLIENT_SECRET` | cTrader Open API app Client Secret |
| `CTRADER_REDIRECT_URI` | Must exactly match the redirect URI configured on the cTrader app, typically the frontend's Accounts page (e.g. `http://localhost:3000/accounts`) |

## Security Notes

- `.env` files are ignored by Git.
- Registration is open, but every user's data is scoped to their own account — trades, trading accounts, playbooks, knowledge base entries, and investor grants are all queried and written with the authenticated user's id, never globally.
- Each user's MT5 sync agent is authenticated by their own personal secret (its hash, not the plaintext, is what's stored), so one user's `sync.py` can never write into another user's account, even on a shared installation.
- API routes require JWT authentication and scope data to the authenticated user. CORS is pinned to an explicit origin allowlist (`ALLOWED_ORIGINS`) rather than reflecting every request origin.
- MT5 credentials and cTrader OAuth tokens are encrypted independently per field with AES-256-GCM (`ACCOUNT_ENCRYPTION_KEY`) before storage and are never returned to the browser.
- Login and investor-login attempts are rate-limited per IP.
- Sync-agent and investor JWTs are restricted, at the auth-middleware level, to an explicit allowlist of routes for that role — neither can reach owner journal endpoints regardless of what else the token contains.
- Investor access uses a bcrypt-hashed, rotatable password behind a stable account number; every investor request re-checks the account's live `investor.enabled` flag, so revoking access from the Accounts page locks out an already-issued, unexpired token on its very next request. Investor data is limited to financial fields — no notes, emotions, screenshots, or checklists.
- Cloudinary recovery only scans the authenticated user's folder prefix.
- Offline screenshots are removed from local staging after successful Cloudinary upload.
- Published playbook versions referenced by trades are immutable audit records.
