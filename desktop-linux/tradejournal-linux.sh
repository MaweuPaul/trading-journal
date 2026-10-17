#!/usr/bin/env bash
# TradeJournal MT5 sync for Linux (beta).
#
# MetaTrader 5 has no Linux version: on Linux it runs under Wine, and the
# MetaTrader5 Python package that reads its history only works on Windows.
# So this installs Windows Python into the same Wine prefix as MT5 and runs
# the same sync.py the Windows app uses, as a background user service.
#
#   bash tradejournal-linux.sh            set up (or set up again) and start
#   bash tradejournal-linux.sh status     is it running?
#   bash tradejournal-linux.sh logs       follow the sync log
#   bash tradejournal-linux.sh stop|start|restart
#   bash tradejournal-linux.sh update     get the newest sync script
#   bash tradejournal-linux.sh run        run in this terminal instead of as a service
#   bash tradejournal-linux.sh uninstall
#
# Environment overrides: WINEPREFIX (the MT5 Wine prefix), TJ_API_BASE.
set -euo pipefail

API_BASE="${TJ_API_BASE:-https://trading-journal-x5fe.onrender.com/api}"
PYTHON_VERSION="3.11.9"
PYTHON_URL="https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tradejournal"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tradejournal"
SERVICE_NAME="tradejournal-sync"
SERVICE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${SERVICE_NAME}.service"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

have_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }

# The Wine prefix that holds MT5: $WINEPREFIX, MetaQuotes' installer default (~/.mt5), or ~/.wine.
find_prefix() {
  local p
  for p in "${WINEPREFIX:-}" "$HOME/.mt5" "$HOME/.wine"; do
    [ -n "$p" ] && [ -d "$p/drive_c" ] || continue
    if [ -n "$(find_terminal "$p")" ]; then echo "$p"; return 0; fi
  done
  return 1
}

find_terminal() { find "$1/drive_c" -maxdepth 4 -iname terminal64.exe -print -quit 2>/dev/null; }
find_python()   { find "$1/drive_c" -maxdepth 8 -ipath '*Python311*' -iname python.exe -print -quit 2>/dev/null; }

load_config() {
  [ -f "$CONFIG_DIR/linux.conf" ] || die "Not set up yet. Run: bash $0"
  # shellcheck disable=SC1091
  . "$CONFIG_DIR/linux.conf"
}

download() { # url file
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else die "Install curl or wget first."; fi
}

fetch_sync_script() {
  mkdir -p "$APP_DIR"
  say "Downloading the sync script..."
  download "$API_BASE/downloads/sync-script" "$APP_DIR/sync.py.new" || die "Couldn't download the sync script from $API_BASE."
  mv "$APP_DIR/sync.py.new" "$APP_DIR/sync.py"
}

install() {
  command -v wine >/dev/null 2>&1 || die "Wine isn't installed. Install MetaTrader 5 for Linux first (it sets up Wine): https://www.metatrader5.com/en/terminal/help/start_advanced/install_linux"

  local prefix terminal python key
  prefix="$(find_prefix)" || die "Couldn't find MetaTrader 5 in a Wine prefix (looked in \$WINEPREFIX, ~/.mt5 and ~/.wine). Install MT5 first, or run with WINEPREFIX=/path/to/prefix."
  terminal="$(find_terminal "$prefix")"
  say "Found MetaTrader 5: $terminal"
  export WINEPREFIX="$prefix" WINEDEBUG=-all

  python="$(find_python "$prefix" || true)"
  if [ -z "$python" ]; then
    say "Installing Windows Python $PYTHON_VERSION into the MT5 Wine prefix (a few minutes)..."
    local tmp; tmp="$(mktemp -d)"
    download "$PYTHON_URL" "$tmp/python-installer.exe"
    wine "$tmp/python-installer.exe" /quiet InstallAllUsers=0 PrependPath=0 Include_launcher=0 Include_test=0 Include_doc=0 Include_tcltk=0 || true
    rm -rf "$tmp"
    python="$(find_python "$prefix" || true)"
    [ -n "$python" ] || die "Python didn't install into $prefix. Try again, or install Python $PYTHON_VERSION (64-bit) into that prefix by hand."
  fi
  say "Python: $python"

  say "Installing the sync's Python packages..."
  wine "$python" -m pip install --disable-pip-version-check -q --upgrade "MetaTrader5>=5.0.5735" "requests>=2.28.0" "python-dotenv>=1.0.0" "numpy>=1.7" \
    || die "Installing Python packages failed. Check your internet connection and run this again."

  fetch_sync_script

  if [ -f "$APP_DIR/.env" ] && grep -q '^SYNC_SECRET=.' "$APP_DIR/.env"; then
    read -r -p "Keep the sync key you entered before? [Y/n] " keep
    case "${keep:-y}" in [nN]*) key="";; *) key="$(sed -n 's/^SYNC_SECRET=//p' "$APP_DIR/.env")";; esac
  fi
  while [ -z "${key:-}" ]; do
    read -r -s -p "Paste your sync key (Accounts page in TradeJournal): " key; echo
  done

  ( umask 077
    printf 'API_BASE=%s\nSYNC_SECRET=%s\nMT5_PATH=%s\n' "$API_BASE" "$key" "$(winepath -w "$terminal")" > "$APP_DIR/.env" )
  mkdir -p "$CONFIG_DIR"
  printf 'PREFIX=%q\nPYTHON=%q\n' "$prefix" "$python" > "$CONFIG_DIR/linux.conf"

  if have_systemd; then
    mkdir -p "$(dirname "$SERVICE_FILE")"
    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=TradeJournal MT5 sync (runs sync.py under Wine)
After=network-online.target graphical-session.target

[Service]
Environment=WINEPREFIX=$prefix
Environment=WINEDEBUG=-all
Environment=PYTHONUNBUFFERED=1
WorkingDirectory=$APP_DIR
ExecStart=$(command -v wine) "$python" sync.py
Restart=always
RestartSec=60

[Install]
WantedBy=default.target
EOF
    # MT5 is a window: if the sync has to start it, it needs the desktop session's display.
    systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY 2>/dev/null || true
    systemctl --user daemon-reload
    systemctl --user enable --now "$SERVICE_NAME" >/dev/null
    systemctl --user restart "$SERVICE_NAME"
    say ""
    say "Done. Trades sync in the background whenever you're logged in."
    echo "  Keep MetaTrader 5 open and logged in."
    echo "  Check it:    bash $0 status"
    echo "  Watch it:    bash $0 logs"
  else
    say ""
    say "Done, but systemd isn't available, so it can't run in the background."
    echo "  Start it in a terminal (and leave that open):  bash $0 run"
  fi
}

case "${1:-install}" in
  install) install ;;
  run)
    load_config
    cd "$APP_DIR" && WINEPREFIX="$PREFIX" WINEDEBUG=-all PYTHONUNBUFFERED=1 exec wine "$PYTHON" sync.py ;;
  status)    have_systemd || die "systemd isn't available; use: bash $0 run"; systemctl --user status "$SERVICE_NAME" --no-pager ;;
  logs)      have_systemd || die "systemd isn't available; use: bash $0 run"; journalctl --user -u "$SERVICE_NAME" -f -n 50 ;;
  start|stop|restart) systemctl --user "$1" "$SERVICE_NAME" ;;
  update)
    load_config; fetch_sync_script
    if have_systemd; then systemctl --user restart "$SERVICE_NAME"; fi
    say "Updated." ;;
  uninstall)
    if have_systemd; then systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true; rm -f "$SERVICE_FILE"; systemctl --user daemon-reload; fi
    rm -rf "$APP_DIR" "$CONFIG_DIR"
    say "Removed. (Python stays in the MT5 Wine prefix; MetaTrader 5 itself is untouched.)" ;;
  *) die "Unknown command '$1'. Use: install, status, logs, start, stop, restart, update, run, uninstall." ;;
esac
