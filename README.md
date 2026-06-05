# TradeJournal - Personal MT5 Trading Analytics Portal

A self-hosted, offline-resilient trading journal that syncs closed trades from MetaTrader 5 and presents performance through a private dashboard.

## Features

| Feature | Description |
|---|---|
| Auto MT5 Sync | Python script polls MT5 and pushes closed deals to the backend |
| Dashboard | Live account balance, equity curve, and headline metrics |
| Performance | Equity curve, drawdown chart, profit factor, expectancy, and R:R ratio |
| Trading Calendar | Daily P&L heatmap with drill-down trades |
| Analytics | Breakdown by session, symbol, emotion, setup grade, day of week, and tags |
| Offline Resilience | Falls back to local JSON if MongoDB is unreachable |
| Private by Design | Public registration disabled; single-user credential-locked access |

## Architecture

```text
MetaTrader 5
    -> sync.py polls closed trades
    -> POST /api/sync
Backend (Express :4000)
    -> saves to MongoDB Atlas or local_trades.json fallback
Frontend (Next.js :3000)
    -> fetches via JWT-authenticated API
```

## Tech Stack

- Frontend: Next.js, React, Recharts, CSS
- Backend: Node.js, Express, Mongoose, JWT
- Sync: Python 3, MetaTrader5 SDK, python-dotenv
- Database: MongoDB Atlas plus local JSON fallback

## Setup

### Backend

```bash
cd backend
npm install
cp .env.example .env
npm run dev
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

```text
backend/
  middleware/auth.js
  models/Trade.js
  models/User.js
  routes/auth.js
  routes/trades.js
  server.js
frontend/
  app/page.tsx
  app/trades/
  app/calendar/
  app/stats/
  app/performance/
  components/Sidebar.tsx
sync.py
requirements.txt
```

## Environment Variables

### Root `.env` for `sync.py`

| Variable | Description |
|---|---|
| `MT5_LOGIN` | Your MT5 account number |
| `MT5_PASSWORD` | Your MT5 password |
| `MT5_SERVER` | Your broker's MT5 server name |
| `API_BASE` | Backend API URL |
| `SYNC_INTERVAL` | Sync frequency in seconds |
| `USER_EMAIL` | Admin email |
| `USER_PASSWORD` | Admin password |

### `backend/.env`

| Variable | Description |
|---|---|
| `PORT` | Backend port |
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | Long random string for JWT signing |
| `ADMIN_EMAIL` | Admin user email |
| `ADMIN_PASSWORD` | Admin user password |

## Security Notes

- `.env` files are ignored by git.
- Public registration is disabled.
- All trade API routes require JWT authentication.
- Trade data is scoped to the authenticated user.
