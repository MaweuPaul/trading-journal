# TradeJournal Sync Agent (desktop)

A small Electron wrapper around `sync.py` — a native settings window and tray
icon instead of hand-editing a `.env` file and running the script from a
terminal. It doesn't reimplement any sync logic; it just spawns the existing
`sync.py` as a background process, feeds it the right environment variables,
supervises it (restarts on an unexpected crash, with backoff), and streams
its output into a log view.

It only ever handles your **sync secret** (from the Accounts page) and the
backend API URL — never your MT5 password. That still lives encrypted on the
backend and is only ever decrypted for `sync.py` itself to use, exactly as
before.

## Prerequisites

- **Python 3** installed and on `PATH` (this app looks for `python` then
  `python3`) — required because `sync.py`'s MT5 connectivity depends on the
  `MetaTrader5` Python package, which is Windows-only. This desktop shell
  itself is cross-platform, but real MT5 syncing only works on Windows.
- Node.js, for running this Electron project itself in development.

## Installation

1. Build the installer (see **Packaging** below) or grab
   `TradeJournal Sync Agent Setup <version>.exe` from wherever it was shared
   with you, and run it — it's a one-click installer, no prompts.
2. Make sure the **backend** is running and reachable (`npm run start` or
   `npm run dev` in `backend/`) before starting a sync — the agent
   authenticates against it and will just retry-loop with a connection error
   otherwise.
3. On first launch, fill in the two connection fields:
   - **Backend API URL** — where your backend actually lives. Defaults to
     `http://localhost:4000/api`, which is correct if the backend runs on
     this same machine. If it's deployed elsewhere (another machine on your
     network, a VPS, etc.), put its real reachable address here instead —
     `http://<host>:4000/api` or your deployed URL, whatever `curl` would
     need to hit it from this machine.
   - **Sync secret** — from the journal's **Accounts** page (generated at
     signup, rotatable any time). Identifies you to the backend; never your
     MT5 password.
4. Click **Install/update dependencies** once (installs `sync.py`'s Python
   requirements), then **Start Sync**. The Activity Log should show
   `[AUTH] Authenticating with the installation sync secret...` followed by
   `Sync pipeline authenticated successfully.` and then MT5 sync activity.

## Development

```bash
cd desktop
npm install
npm start
```

## Packaging

```bash
npm run dist
```

This bundles `../sync.py` and `../requirements.txt` alongside the packaged
app (see `package.json`'s `build.extraResources`) so the installed app is
self-contained apart from the Python 3 requirement above.

`assets/icon.png` (and its source, `assets/icon.svg`) match the app's gold
trending-up mark used everywhere else — the login logo, sidebar, favicon.
Regenerate it after editing the SVG with:

```bash
cd desktop
node_modules/.bin/electron scripts/render-icon.js
```

`electron-builder` generates the platform-specific formats it needs (`.ico`
for Windows, `.icns` for macOS) from this single PNG at package time.

## What it stores locally

A small `config.json` in Electron's per-user app-data directory:
`{ apiBase, syncSecret, syncInterval, requireRealAccount }`. Nothing else —
no trade data, no MT5 credentials.
