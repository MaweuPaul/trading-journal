# TradeJournal — Personal MT5 Trading Analytics Portal

A self-hosted, offline-resilient trading journal that syncs closed trades from MetaTrader 5 and presents performance through a private dashboard.

## Features

| Feature | Description |
|---|---|
| Auto MT5 Sync | Python script polls MT5 and pushes closed deals to the backend |
| Dashboard | Live account balance, equity curve, and headline metrics |
| Performance | Equity curve, drawdown chart, profit factor, expectancy, and R:R ratio |
| Trading Calendar | Daily P&L heatmap with drill-down trades |
| Analytics | Breakdown by session, symbol, emotion, setup grade, day of week, and tags |
| Screenshot Uploads | Attach chart screenshots to any trade with Cloudinary hosting |
| Screenshot Metadata | Every screenshot embeds full trade data as Cloudinary context tags + a sidecar JSON file for reconstruction without MongoDB |
| Offline Screenshots | Screenshots save to server disk when MongoDB is offline; auto-upload to Cloudinary on reconnect with full cleanup |
| Data Export | One-click JSON backup (trades + account events) and CSV export from the Backup page |
| 24h Auto-Backup | Server mirrors MongoDB → local_trades.json every 24 hours automatically |
| Offline Resilience | Falls back to local JSON if MongoDB is unreachable — all routes work without a live database |
| Private by Design | Public registration disabled; single-user credential-locked access |

## Redundancy Architecture

The journal is designed so you can **always reconstruct your data** even if you lose access to MongoDB or Cloudinary.

### Data Layers (in priority order)

```
1. MongoDB Atlas          — primary live database
2. local_trades.json      — full mirror on server disk, refreshed every 24h and on startup
3. Cloudinary images      — each screenshot has contextual metadata tags containing the
                            full trade record (symbol, direction, P&L, prices, times, etc.)
4. Cloudinary sidecar     — a {imageId}_metadata raw JSON file uploaded alongside each
                            screenshot, containing the complete trade object
5. Offline disk cache     — when MongoDB is offline, screenshots save to
                            backend/public/screenshots/{tradeId}/ with a .meta.json sidecar;
                            auto-uploaded to Cloudinary when MongoDB reconnects
6. Manual exports         — JSON and CSV downloads available from the Backup page at /archive
```

### Screenshot Metadata

Every screenshot upload embeds trade metadata in two places on Cloudinary:

- **Contextual metadata tags**: `symbol`, `direction`, `dealId`, `entryPrice`, `exitPrice`, `pnlUSD`, `pnlPct`, `openTime`, `closeTime`, `lotSize`, `emotion`, `grade`, `tags`, `runningBalance`, `journalVersion`
- **Sidecar `_metadata` file**: A raw JSON file stored in the same Cloudinary folder with the full trade object

This means: even without MongoDB, you can open the Cloudinary dashboard, click any image, and immediately see which trade it belongs to and reconstruct the full record.

## Architecture

```
MetaTrader 5
    -> sync.py polls closed trades every SYNC_INTERVAL seconds
    -> POST /api/sync

Backend (Express :4000)
    -> saves to MongoDB Atlas (primary)
    -> mirrors to local_trades.json (fallback, refreshed every 24h)
    -> serves static offline screenshots at /public/screenshots/

Frontend (Next.js :3000)
    -> fetches via JWT-authenticated API
    -> /archive — Backup & Export page with JSON/CSV download
```

## Tech Stack

- **Frontend**: Next.js 15, React 19, Recharts, Vanilla CSS
- **Backend**: Node.js, Express, Mongoose, JWT, Cloudinary SDK
- **Sync**: Python 3, MetaTrader5 SDK, python-dotenv
- **Database**: MongoDB Atlas + local JSON fallback
- **Images**: Cloudinary (with embedded trade metadata)

## Setup

### Backend

```bash
cd backend
npm install
cp .env.example .env
# Fill in .env (see Environment Variables below)
node server.js
```

### Frontend

```bash
cd frontend
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:4000/api" > .env.local
npm run dev
```

### Python Sync Script

```bash
pip install -r requirements.txt
cp .env.example .env
python sync.py
```

## Project Structure

```
backend/
  middleware/auth.js
  models/Trade.js
  models/User.js
  routes/auth.js
  routes/trades.js          <- all API routes incl. export + screenshot metadata
  server.js
  local_trades.json         <- auto-generated MongoDB mirror
  local_account_events.json <- auto-generated account events mirror
  public/
    screenshots/            <- offline screenshot staging area (auto-cleaned)
frontend/
  app/
    page.tsx                <- dashboard
    trades/                 <- trade list + screenshot upload
    calendar/               <- daily P&L calendar
    stats/                  <- analytics breakdown
    performance/            <- equity curve + risk metrics
    archive/                <- backup & export page
  components/Sidebar.tsx
sync.py
requirements.txt
```

## API — Export Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/export/json` | GET | Full JSON backup: all trades + account events |
| `/api/export/csv` | GET | Flat CSV of all trades (20 columns) |
| `/api/export/status` | GET | DB mode, counts, backup file info, pending offline screenshots |

All export endpoints work in both online (MongoDB) and offline (local cache) modes.

## Environment Variables

### Root `.env` for `sync.py`

| Variable | Description |
|---|---|
| `MT5_LOGIN` | Your MT5 account number |
| `MT5_PASSWORD` | Your MT5 password |
| `MT5_SERVER` | Your broker's MT5 server name |
| `MT5_REQUIRE_REAL_ACCOUNT` | Set `true` to reject demo accounts; default `false` syncs both and labels trades automatically |
| `API_BASE` | Backend API URL |
| `SYNC_INTERVAL` | Sync frequency in seconds |
| `USER_EMAIL` | Admin email |
| `USER_PASSWORD` | Admin password |

### `backend/.env`

| Variable | Description |
|---|---|
| `PORT` | Backend port (default 4000) |
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | Long random string for JWT signing |
| `ADMIN_EMAIL` | Admin user email |
| `ADMIN_PASSWORD` | Admin user password |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name (for screenshot uploads) |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

## Security Notes

- `.env` files are ignored by git.
- Public registration is disabled.
- All trade API routes require JWT authentication.
- Trade data is scoped to the authenticated user.
- Offline screenshots in `backend/public/screenshots/` are automatically deleted after successful Cloudinary upload.
