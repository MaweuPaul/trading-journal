# TradeJournal Sync Agent (native Python rewrite)

A Tkinter rewrite of the old Electron desktop wrapper around `sync.py` — same
job (native settings window, tray icon, process supervision, no manual `.env`
editing), but as a plain Python script instead of an entire bundled Chromium
browser. The packaged installer is ~30MB instead of ~104MB.

It only ever handles your **sync secret** (from the Accounts page) and the
backend API URL — never your MT5 password. That still lives encrypted on the
backend and is only ever decrypted for `sync.py` itself to use.

## Prerequisites

- **Python 3** installed and on `PATH` (this app looks for `python` then
  `python3`) to actually run `sync.py` and install its requirements —
  separate from whatever Python built/runs this GUI itself, since
  `sync.py`'s own dependencies (like `MetaTrader5`) aren't bundled here.

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
```

Produces `dist/TradeJournal Sync Agent.exe` — a single-file PyInstaller
build. It bundles `../sync.py` and `../requirements.txt` alongside the exe
(see `build.py`'s `--add-data` flags) so the installed app is self-contained
apart from the Python 3 requirement above. `assets/icon.ico` is generated
automatically from `assets/icon.png` on first build.

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
