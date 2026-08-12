# TradeJournal — Personal MT5 Trading Analytics Portal

A self-hosted, offline-resilient trading journal that syncs closed MetaTrader 5 trades, preserves an auditable record of strategy changes, and measures what actually contributes to performance.

> New installation? Follow the complete [Setup Guide](SETUP.md). Validating an installation? Use the [Feature Testing Guide](TESTING.md).

## Features

| Feature | Description |
|---|---|
| Automatic MT5 Sync | Python script polls MT5 and sends closed deals and account events to the backend |
| Live/Demo Classification | Detects the connected MT5 account mode, labels trades automatically, and supports account-type filtering |
| Dashboard | Account balance, equity curve, cash-flow-adjusted growth, and headline metrics |
| Performance | Equity curve, drawdown, profit factor, expectancy, and R:R metrics |
| Trading Calendar | Daily P&L heatmap with trade drill-down |
| Analytics | Breakdowns by session, symbol, emotion, grade, weekday, setup, and tags |
| Visual Strategy Playbooks | Build a complete strategy manual from lifecycle stages, detailed fields, and captioned chart evidence |
| Structured Trade Review | Complete Plan, Manage, and Review fields against the exact immutable playbook version used |
| Edge Coach Evidence | Compare versions, stage compliance, structured answers, and numeric fields by outcome and sample size |
| Screenshot Uploads | Attach chart screenshots with Cloudinary hosting and embedded recovery metadata |
| Screenshot Reconstruction | Reattach images or recreate a missing core trade from metadata stored on its screenshot asset |
| Trade Replay | Request only the needed candles from the connected MT5 broker, cache them briefly, replay price action, and use Twelve Data only as a fallback |
| Offline Screenshots | Stage screenshots on disk while MongoDB is unavailable and upload them after reconnection |
| Data Export | Download full JSON backups and flat CSV exports from the Backup page |
| Automatic Backup | Mirror MongoDB into local JSON every 24 hours and on startup |
| Offline Resilience | Fall back to local JSON when MongoDB is unavailable |
| Private by Design | Public registration is disabled and trade routes require authentication |

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
- A full resync backfills the detected type onto matching existing trades.
- The Trades page can show both account types or filter to Live or Demo only.

Set `MT5_REQUIRE_REAL_ACCOUNT=true` if the sync process must reject every non-real account. Leave it `false` to sync and compare both account types.

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
MetaTrader 5
    -> sync.py polls closed deals and account events
    -> POST /api/sync and /api/sync-account-events

Express backend (:4000)
    -> MongoDB Atlas primary storage
    -> local JSON offline mirror
    -> Cloudinary screenshot and sidecar storage

Next.js frontend (:3000)
    -> JWT-authenticated API proxy
    -> /trades  trade list, filters, journal, and playbook review
    -> /rules   versioned playbook builder
    -> /rules/read visual published-playbook reader
    -> /coach   behavior and playbook evidence
    -> /archive backup, export, and recovery controls
```

## Tech Stack

- **Frontend:** Next.js 15, React 19, Recharts, Vanilla CSS
- **Backend:** Node.js, Express, Mongoose, JWT, Cloudinary SDK
- **Sync:** Python 3, MetaTrader5 SDK, Requests, python-dotenv
- **Database:** MongoDB Atlas with local JSON fallback
- **Images:** Cloudinary with context metadata and raw JSON sidecars

## Setup

### Create the personal owner

This is a single-owner journal. It supports two first-run options:

1. Leave `SEED_OWNER_ENABLED=false`, start MongoDB and the backend, then open `/signup`. Registration is available only while the user collection is empty and locks permanently after the owner is created.
2. Set `SEED_OWNER_ENABLED=true` with `OWNER_NAME`, `OWNER_EMAIL`, and `OWNER_PASSWORD`. The backend creates the owner only when no user exists.

Environment seeding is create-only: restarting the backend never overwrites an existing owner's name, email, or password. If an owner already exists, both environment seeding and `POST /api/auth/register` are ignored or rejected.

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

## Project Structure

```text
backend/
  middleware/auth.js
  models/
    Trade.js
    User.js
    AccountEvent.js
    SyncRequest.js
  routes/
    auth.js
    trades.js              # trades, playbooks, analytics, exports, screenshots
  local_trades.json        # generated local trade mirror
  local_account_events.json
  local_playbooks.json     # generated offline playbook storage
  public/screenshots/      # offline screenshot staging area
  server.js
frontend/
  app/
    trades/                # trade list, filters, journal, screenshots
    rules/                 # versioned strategy playbook builder
    coach/                 # Edge Coach evidence
    stats/                 # analytics breakdowns
    performance/           # equity and risk metrics
    calendar/              # P&L calendar
    archive/               # backup and recovery
  components/Sidebar.tsx
sync.py
requirements.txt
```

## Key API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/trades` | GET | Paginated trades with `symbol`, `direction`, `accountType`, `from`, and `to` filters |
| `/api/trades/:id` | PUT | Update journal data and attach a canonical playbook snapshot |
| `/api/trades/:id/replay` | GET | Return temporarily cached candles or queue an on-demand MT5 replay request; `?fallback=twelve` uses the optional fallback |
| `/api/trades/:id/replay-journal` | GET | Load saved chart annotations for one trade and timeframe |
| `/api/trades/:id/replay-journal/annotations` | PUT | Validate and autosave zones, lines, levels, arrows, text, and image pins for one timeframe |
| `/api/trades/:id/replay-journal/events` | PUT | Validate and autosave the candle-linked trade-event timeline |
| `/api/trades/:id/replay-journal/quick-review` | PUT | Autosave or complete the short process-focused review |
| `/api/trades/:id/replay-journal/draft` | PUT | Autosave unfinished journal answers and Replay position |
| `/api/replay-requests` | GET | Let the authenticated local sync agent claim pending replay requests |
| `/api/trades/:id/replay-candles` | POST | Validate and temporarily cache broker OHLC candles returned by `sync.py` |
| `/api/sync` | POST | Receive MT5 closed trades and backfill Live/Demo labels |
| `/api/auth/setup-status` | GET | Report whether the one-time owner Signup page is available |
| `/api/auth/register` | POST | Create the owner only when the database contains zero users |
| `/api/playbooks` | GET / POST | List playbooks or publish a new strategy |
| `/api/playbooks/evidence` | POST | Upload reusable visual evidence for a draft playbook stage |
| `/api/playbooks/:playbookId` | PUT | Publish a new immutable version |
| `/api/playbooks/:playbookId` | PATCH | Archive or restore a strategy |
| `/api/coach` | GET | Behavioral, version, and rule-answer analytics |
| `/api/maintenance/recover-screenshots` | POST | Reattach screenshots and reconstruct missing core trades |
| `/api/export/json` | GET | Full JSON backup of trades and account events |
| `/api/export/csv` | GET | Flat CSV trade export |
| `/api/export/status` | GET | Database, backup, and pending screenshot status |

All endpoints require authentication except login and health checks. Export and recovery routes work with the same authenticated user scope as trade routes.

## Environment Variables

### Root `.env` for `sync.py`

| Variable | Description |
|---|---|
| `MT5_LOGIN` | MT5 account number |
| `MT5_PASSWORD` | MT5 password |
| `MT5_SERVER` | Broker server name |
| `MT5_REQUIRE_REAL_ACCOUNT` | Set `true` to reject demo accounts; default `false` syncs and labels both account types |
| `API_BASE` | Backend API URL, normally `http://localhost:4000/api` |
| `API_TIMEOUT` | HTTP timeout in seconds |
| `SYNC_INTERVAL` | Polling interval in seconds |
| `USER_EMAIL` | Journal admin email used by the sync process |
| `USER_PASSWORD` | Journal admin password used by the sync process |

### MT5-first trade replay

Keep `sync.py` and the logged-in MT5 desktop terminal running. `sync.py` holds a lightweight 25-second long poll against the authenticated replay queue. Opening Replay writes only the selected trade's broker symbol, time window, and appropriate timeframe to a MongoDB TTL session; the waiting agent receives it immediately, uses `copy_rates_range`, and returns the candles to that temporary session. Candles are never written to the trade or downloaded for unrelated trades.

The shared TTL session works across cloud instances and expires after 30 minutes. Replay shows the provider and connection diagnostics. Its journal panel reads the immutable playbook snapshot already attached to the trade, organizes rules into Plan, Execution, and Review, and saves edited answers without replacing that historical version. Select **Use Twelve Data fallback** only when the terminal cannot supply the history.

Replay supports independently cached `1m`, `5m`, `15m`, `1H`, `4H`, and `1D` views. Switching timeframe requests only that broker interval, preserves the trade entry/exit timestamps, and leaves other timeframe sessions available until their TTL expires. The session identity is `user + trade + timeframe`, so multiple views never overwrite one another.

The browser also holds an 8-second Replay request open, allowing the backend to return as soon as MT5 uploads the requested interval instead of waiting for another browser polling delay. Expanded windows target roughly 700–1,100 surrounding bars depending on market hours and timeframe. Replay provides TradingView-style documentation tools for zones, trend lines, horizontal levels, arrows, colored text, candle events, and image evidence pinned to an exact time and price. Annotations are stored by trade and timeframe, autosave after changes, reload after refresh, and are included in JSON backups.

Choose **Select** to click an existing chart object. The selected object receives a visible outline and can be removed with the toolbar **Delete** button or the keyboard Delete/Backspace key; **Undo**, individual list deletion, and protected **Clear all** remain available. Image pins reuse the journal screenshot upload pipeline, keep the uploaded evidence attached to the trade, and display a captioned preview on the chart. Static annotations remain hidden until their point anchor or all shape anchors have been revealed, so playback never exposes a future chart note early.

Replay's **Event** tool attaches observations, confirmations, entry/management/exit decisions, emotions, mistakes, rule violations, lessons, or custom events to exact candle time and price. Events can carry importance, notes, emotion, and a rule from the trade's immutable playbook snapshot. The journal timeline autosaves, orders events chronologically, renders chart markers as playback reveals them, and navigates back to an event even when it belongs to another timeframe.

Replay is designed for reviewing the story of a recorded trade, not replacing chart-analysis software. Playback can auto-pause at entry and exit, jump directly to those trade markers, or move between the previous and next journal event. Entry, exit, and decision moments are visible on the scrubber. Keyboard review keeps attention on the chart: Space plays/pauses, arrows step candles, `E`/`X` jump to entry/exit, brackets move between review moments, `Y`/`N` answer plan adherence, `1`–`6` choose emotion, and `A`–`F` set the process grade. Shortcuts never fire while typing in a form field.

Quick Review follows a deliberate sequence. Plan adherence, emotion, the relevant mistake/strength, and the main lesson must be recorded before the process grade unlocks. A non-blocking honesty check flags contradictory combinations such as “did not follow the plan” with an A/B process grade; the trader remains responsible for the final judgment.

Each timeline event also has an explicit visibility scope. **This timeframe** is the default and is best for chart-specific evidence such as a 5-minute displacement. **All timeframes** is intended for trade-wide decisions and lessons; the same event is positioned by timestamp and price as the trader switches charts. Existing events without this field remain timeframe-specific.

The journal panel opens in **Quick Review** so an ordinary trade can be reviewed in five short answers: plan adherence, primary emotion, the main mistake or repeatable strength, one lesson, and a process grade. Drafts autosave. **Mark Complete & Save** validates the review and mirrors its emotion and grade onto the trade for existing Stats and Edge Coach reports. **Deep Playbook** keeps the full immutable strategy review available when more evidence is warranted.

Replay also keeps an ownership-scoped server draft for unfinished notes, tags, playbook answers, detailed grades, outcome fields, timeframe, revealed candle, speed, and journal phase. The save indicator confirms when it is safe to refresh or close. URL parameters continue to hold shareable navigation state; private journal content is never placed in the URL or local storage.

### `backend/.env`

| Variable | Description |
|---|---|
| `PORT` | Express port, default `4000` |
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | Long random JWT signing secret |
| `SEED_OWNER_ENABLED` | Set `true` to create the first owner from environment variables |
| `OWNER_NAME` | Owner name used only during first-time environment seeding |
| `OWNER_EMAIL` | Owner email used for seeding and optional offline login |
| `OWNER_PASSWORD` | Owner password used only for first-time seeding and optional offline login; minimum 8 characters |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

## Security Notes

- `.env` files are ignored by Git.
- Public registration is disabled.
- Signup is a one-time owner setup route and rejects every request after any user exists.
- API routes require JWT authentication and scope data to the authenticated user.
- Cloudinary recovery only scans the authenticated user's folder prefix.
- Offline screenshots are removed from local staging after successful Cloudinary upload.
- Published playbook versions referenced by trades are immutable audit records.
