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
