# TradeJournal — Personal MT5 Trading Analytics Portal

A self-hosted, offline-resilient trading journal that syncs closed MetaTrader 5 trades, preserves an auditable record of strategy changes, and measures what actually contributes to performance.

## Features

| Feature | Description |
|---|---|
| Automatic MT5 Sync | Python script polls MT5 and sends closed deals and account events to the backend |
| Live/Demo Classification | Detects the connected MT5 account mode, labels trades automatically, and supports account-type filtering |
| Dashboard | Account balance, equity curve, cash-flow-adjusted growth, and headline metrics |
| Performance | Equity curve, drawdown, profit factor, expectancy, and R:R metrics |
| Trading Calendar | Daily P&L heatmap with trade drill-down |
| Analytics | Breakdowns by session, symbol, emotion, grade, weekday, setup, and tags |
| Versioned Playbooks | Build custom strategies from flexible blocks and rules; every publish creates an immutable version |
| Structured Trade Review | Record Yes/No, choice, number, rating, or text answers against the exact playbook version used |
| Edge Coach Evidence | Compare strategy versions and rule answers by sample size, win rate, and average P&L |
| Screenshot Uploads | Attach chart screenshots with Cloudinary hosting and embedded recovery metadata |
| Screenshot Reconstruction | Reattach images or recreate a missing core trade from metadata stored on its screenshot asset |
| Offline Screenshots | Stage screenshots on disk while MongoDB is unavailable and upload them after reconnection |
| Data Export | Download full JSON backups and flat CSV exports from the Backup page |
| Automatic Backup | Mirror MongoDB into local JSON every 24 hours and on startup |
| Offline Resilience | Fall back to local JSON when MongoDB is unavailable |
| Private by Design | Public registration is disabled and trade routes require authentication |

## Versioned Strategy Playbooks

Playbooks use an append-only audit model:

1. Create a strategy such as London ORB, FVG Continuation, or a completely custom setup.
2. Add custom blocks such as Market Context, Location, Entry Confirmation, Risk, and Execution.
3. Add rules with answer types: Yes/No, single choice, multiple choice, number, rating, or text.
4. Publish the strategy to create version 1.
5. Edit and publish again to create version 2. Version 1 is never overwritten.
6. Review a trade against a published version. The trade stores the version ID, complete rule snapshot, and structured responses.
7. Edge Coach compares versions and answers without changing historical results.

Removing a rule only excludes it from the next published version. Previous versions and attached trades retain the original rule. Archiving a playbook hides it from new selections without deleting its audit history.

Existing flat trading rules are migrated into a starter playbook automatically.

### Edge Coach Evidence

For playbook-backed trades, Edge Coach reports:

- Trade count, win rate, and average P&L for each strategy version.
- Outcomes grouped by each structured rule answer.
- Evidence labels based on sample size: insufficient (`<5`), developing (`5–19`), and strong (`20+`).

Boolean, single-choice, multiple-choice, and rating answers currently feed effectiveness comparisons. Number and text answers remain preserved in the audit record for later numerical or qualitative analysis.

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
| `/api/sync` | POST | Receive MT5 closed trades and backfill Live/Demo labels |
| `/api/playbooks` | GET / POST | List playbooks or publish a new strategy |
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

### `backend/.env`

| Variable | Description |
|---|---|
| `PORT` | Express port, default `4000` |
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | Long random JWT signing secret |
| `ADMIN_EMAIL` | Private admin email |
| `ADMIN_PASSWORD` | Private admin password |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

## Security Notes

- `.env` files are ignored by Git.
- Public registration is disabled.
- API routes require JWT authentication and scope data to the authenticated user.
- Cloudinary recovery only scans the authenticated user's folder prefix.
- Offline screenshots are removed from local staging after successful Cloudinary upload.
- Published playbook versions referenced by trades are immutable audit records.
