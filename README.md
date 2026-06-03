# 📊 TradeJournal — Personal MT5 Trading Analytics Portal

A self-hosted, offline-resilient trading journal that automatically syncs closed trades from **MetaTrader 5**, captures chart screenshots, and presents your performance through a premium dashboard.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔄 **Auto MT5 Sync** | Python script polls MT5 every 60s and pushes closed deals to the backend |
| 📸 **Auto Screenshots** | MQ5 Expert Advisor captures entry & exit chart screenshots, synced to Cloudinary |
| 📊 **Performance Page** | Equity curve, drawdown chart, profit factor, expectancy, R:R ratio |
| 📅 **Trading Calendar** | Daily P&L heatmap — click any day to see its trades |
| 🧠 **Analytics** | Breakdown by session, symbol, emotion, setup grade, day of week |
| 🖼️ **Visual Review** | Screenshot gallery with full-screen lightbox — review every trade visually |
| 💾 **Offline Resilience** | Falls back to local JSON if MongoDB is unreachable — zero data loss |
| 🔒 **Private by design** | Public registration disabled — single-user, credential-locked |

---

## 🏗️ Architecture

```
MetaTrader 5 (MQ5 EA)
    ↓ auto-captures screenshots → MQL5/Files/
    ↓ sync.py polls every 60s
    ↓ POST /api/sync + POST /api/upload-local-screenshot
Backend (Express :4000)
    ↓ uploads to Cloudinary
    ↓ saves to MongoDB Atlas (falls back to local_trades.json)
Frontend (Next.js :3000)
    ↓ fetches via JWT-authenticated API
```

---

## 🛠️ Tech Stack

- **Frontend**: Next.js 15, React, Recharts, Vanilla CSS
- **Backend**: Node.js, Express, Mongoose, JWT, Cloudinary SDK
- **Sync**: Python 3, MetaTrader5 SDK, python-dotenv
- **Database**: MongoDB Atlas + local JSON fallback

---

## ⚙️ Setup

### 1. Clone the repo

```bash
git clone https://github.com/your-username/tradejournal.git
cd tradejournal
```

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env
# Fill in your values in .env
npm run dev
```

### 3. Frontend

```bash
cd frontend
npm install
# Create frontend/.env.local:
echo "NEXT_PUBLIC_API_URL=http://localhost:4000/api" > .env.local
npm run dev
```

### 4. Python Sync Script

```bash
pip install -r requirements.txt
cp .env.example .env
# Fill in your values in .env
python sync.py
```

### 5. MT5 Expert Advisor

1. Copy `TradeScreenshot.mq5` to your MT5 `MQL5/Experts/` folder
2. Compile it in MetaEditor (F7)
3. Attach it to any chart in MT5
4. It will automatically save `{position_id}_entry.png` and `{position_id}_exit.png` to `MQL5/Files/` on every trade

---

## 📂 Project Structure

```
├── backend/
│   ├── middleware/auth.js          # JWT middleware
│   ├── models/Trade.js             # Trade schema
│   ├── models/User.js              # User schema
│   ├── routes/auth.js              # Auth endpoints
│   ├── routes/trades.js            # Trade sync, analytics, screenshots
│   ├── server.js                   # Express server
│   ├── .env.example                # ← copy to .env and fill in values
│   └── package.json
│
├── frontend/
│   ├── app/
│   │   ├── page.tsx                # Dashboard
│   │   ├── trades/                 # Trade list + journal drawer
│   │   ├── calendar/               # Daily P&L calendar
│   │   ├── stats/                  # Analytics breakdowns
│   │   ├── performance/            # Equity curve + risk metrics
│   │   └── archive/                # Visual screenshot review
│   ├── components/Sidebar.tsx
│   └── package.json
│
├── sync.py                         # MT5 → backend sync pipeline
├── TradeScreenshot.mq5             # MT5 EA for auto screenshot capture
├── requirements.txt
├── .env.example                    # ← copy to .env and fill in values
└── .gitignore
```

---

## 🔐 Environment Variables

### Root `.env` (for `sync.py`)

| Variable | Description |
|---|---|
| `MT5_LOGIN` | Your MT5 account number |
| `MT5_PASSWORD` | Your MT5 password |
| `MT5_SERVER` | Your broker's MT5 server name |
| `API_BASE` | Backend API URL (default: `http://localhost:4000/api`) |
| `SYNC_INTERVAL` | Sync frequency in seconds (default: `60`) |
| `USER_EMAIL` | Your journal admin email |
| `USER_PASSWORD` | Your journal admin password |
| `MT5_FILES_DIR` | Full path to MT5 `MQL5/Files/` folder |

### `backend/.env`

| Variable | Description |
|---|---|
| `PORT` | Backend port (default: `4000`) |
| `MONGODB_URI` | MongoDB Atlas connection string |
| `JWT_SECRET` | Long random string for JWT signing |
| `ADMIN_EMAIL` | Admin user email |
| `ADMIN_PASSWORD` | Admin user password |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

---

## 📸 About TradeScreenshot.mq5

This is a **MetaTrader 5 Expert Advisor** (robot) that runs silently inside MT5. It doesn't trade — it only listens for position open/close events and automatically takes a 1920×1080 screenshot of the active chart at the moment of each event.

Files are saved as:
- `{position_id}_entry.png` — captured when trade opens
- `{position_id}_exit.png` — captured when trade closes

The `sync.py` script detects these files, uploads them to Cloudinary, and links the URLs to the matching trade record in MongoDB. This gives you a complete visual archive of every trade you take.

---

## 🛡️ Security Notes

- `.env` files are in `.gitignore` — they are **never committed**
- Public registration is permanently disabled
- All API routes require JWT authentication
- Trade data is scoped to the authenticated user

---

## 📄 License

MIT — personal use.
