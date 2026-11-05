# TradeJournal Sync Agent (native Python rewrite)

A Tkinter rewrite of the old Electron desktop wrapper around `sync.py` — same
job (native settings window, tray icon, process supervision, no manual `.env`
editing), but as a plain Python script instead of an entire bundled Chromium
browser. The packaged installer is ~30MB instead of ~104MB.

It only ever handles your **sync secret** (from the Accounts page) and the
backend API URL — never your MT5 password. `sync.py` reads whichever account is
logged in to your MT5 and never logs in itself.

## Prerequisites

- **MetaTrader 5** installed and **open** (logged into the account added on
  the Accounts page) whenever Sync is started — `sync.py` attaches to an
  already-running terminal via `mt5.initialize()`, it doesn't launch one.
- Nothing else. The packaged app carries its own Python plus everything
  `sync.py` imports (`MetaTrader5`, `numpy`, `requests`, `python-dotenv`),
  and runs the sync by starting itself again with `--run-sync` (see
  `run_bundled_sync()` in `sync_agent_gui.py`). Only the dev script below
  (`python sync_agent_gui.py`) uses a system Python and offers to install
  `requirements.txt` into it.

## Development

```bash
cd desktop-py
pip install -r requirements.txt
python sync_agent_gui.py
```

## Packaging

```bash
cd desktop-py
python build.py
# while the app in dist/ is running (files locked), build elsewhere:
# SYNC_AGENT_DISTPATH=C:/some/temp/dir python build.py
```

Produces `release/TradeJournal Sync Agent.zip` — a `--onedir` PyInstaller
build zipped up (not `--onefile`; the one-file self-extracting stub is a
common false-positive trigger for antivirus/browser download scanners on
small unsigned Python apps). It bundles `../sync.py`, `../requirements.txt`,
and `VERSION` (see `build.py`'s `--add-data` flags) so the installed app is
fully self-contained: `build.py` adds `--paths ..` and `--hidden-import sync`
so PyInstaller bundles every package `sync.py` imports. `assets/icon.ico`
is generated automatically from `assets/icon.png` on first build.

`release/` is committed on purpose (unlike the git-ignored `dist/`/`build/`
scratch folders) so the built zip deploys along with the rest of the
backend on Render's git-based deploys, and `/api/downloads/sync-agent`
can serve it straight from disk.

### Releasing a new version

Bump the version in `VERSION` before rebuilding — the running app checks
`/api/downloads/sync-agent-version` (which just reads this file) on
startup and shows an "Update available" banner if the deployed version is
newer than the one it was built with.

## What it stores locally

A small `config.json` in `%APPDATA%\TradeJournalSyncAgent\`:
`{ apiBase, syncSecret, syncInterval, requireRealAccount }`. Nothing else —
no trade data, no MT5 credentials.

## Differences from the old Electron version

- No Node.js/npm needed at all, only Python.
- Tray icon requires `pystray` + `Pillow`; if either fails to import the
  app still runs as a normal window (just without tray/minimize-to-tray).
- Single-instance lock uses a fixed local TCP port (`127.0.0.1:47862`)
  instead of Electron's OS-level lock — functionally equivalent.
