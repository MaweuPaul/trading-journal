"""
MT5 -> Trade Journal Sync Script
Connects to MetaTrader 5, fetches closed deals, and POSTs
any new ones to the Node.js backend every SYNC_INTERVAL seconds.

Requirements:
    pip install MetaTrader5 requests python-dotenv

Configuration:
    Copy .env.example to .env in the same directory and fill in your values:
        SYNC_SECRET=THE_SAME_RANDOM_SECRET_AS_THE_BACKEND
        API_BASE=http://localhost:4000/api
        API_TIMEOUT=60
        SYNC_INTERVAL=60

    MT5_LOGIN, MT5_PASSWORD and MT5_SERVER are supported only for the one-time
    automatic migration into encrypted database-managed Trading Accounts.
"""

import time
import logging
import argparse
import threading
import subprocess
from datetime import datetime, timezone
from dotenv import load_dotenv
import os
import requests
import MetaTrader5 as mt5

load_dotenv()

# -- Config -------------------------------------------------------------------
LEGACY_MT5_LOGIN = str(os.getenv("MT5_LOGIN", "")).strip()
LEGACY_MT5_PASSWORD = os.getenv("MT5_PASSWORD", "")
LEGACY_MT5_SERVER = os.getenv("MT5_SERVER", "")
LEGACY_REQUIRE_REAL = os.getenv("MT5_REQUIRE_REAL_ACCOUNT", "false").lower() in {"1", "true", "yes", "on"}
API_BASE      = os.getenv("API_BASE", "http://localhost:4000/api")
API_TIMEOUT   = int(os.getenv("API_TIMEOUT", "60"))
MIN_SYNC_INTERVAL = 25  # seconds; faster cycles add load on the server without syncing anything sooner in practice
try:
    SYNC_INTERVAL = max(MIN_SYNC_INTERVAL, int(os.getenv("SYNC_INTERVAL", "60")))
except ValueError:
    SYNC_INTERVAL = 60
SYNC_SECRET   = os.getenv("SYNC_SECRET", "")
# terminal64.exe to attach to (set by the Linux/Wine setup); blank finds the running terminal.
MT5_PATH      = os.getenv("MT5_PATH", "").strip()
LEGACY_SYMBOL_ALIASES = os.getenv("MT5_SYMBOL_ALIASES", "")

JWT_TOKEN = None
MT5_LOCK = threading.RLock()
ACTIVE_ACCOUNT = None
ACCOUNT_CACHE = {}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("MT5Sync")


def get_jwt_token():
    """Authenticate this local worker without storing the journal password when possible."""
    global JWT_TOKEN
    try:
        auth_url = f"{API_BASE.replace('/api', '')}/api/auth/login"
        if SYNC_SECRET:
            auth_url = f"{API_BASE.replace('/api', '')}/api/auth/sync-agent"
            log.info("[AUTH] Authenticating with the installation sync secret...")
            resp = requests.post(auth_url, headers={"X-Sync-Secret": SYNC_SECRET}, timeout=API_TIMEOUT)
        else:
            log.error("[AUTH] SYNC_SECRET must be configured in .env")
            return False
        resp.raise_for_status()
        data = resp.json()
        JWT_TOKEN = data.get("token")
        log.info("[AUTH] Sync pipeline authenticated successfully.")
        return True
    except Exception as e:
        log.error("[AUTH] Failed to authenticate sync pipeline: %s", e)
        return False


def activate_account(account):
    global ACTIVE_ACCOUNT
    ACTIVE_ACCOUNT = account


# -- Running terminals --------------------------------------------------------
# Only what's logged in syncs. Each running terminal is read as it is: attach,
# read its account, sync it. Never mt5.login(): that would switch the account
# under the trader or a running copier, and a refused login leaves the terminal
# logged out. Copiers and prop traders run one MT5 per account (D:\MT5\Master,
# D:\MT5\10451501...), and each of those is read the same way.
TERMINAL_EXE = "terminal64.exe"
_terminal_listing_failed = False
_terminals_seen = None


def running_terminals():
    """Paths of the MT5 terminals running on this computer."""
    global _terminal_listing_failed, _terminals_seen
    if os.name != "nt" or _terminal_listing_failed:
        return [MT5_PATH] if MT5_PATH else []
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "Get-Process terminal64 -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"],
            capture_output=True, text=True, timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    except Exception as exc:  # no PowerShell (e.g. under Wine): the setup script's MT5_PATH is the terminal
        _terminal_listing_failed = True
        log.info("[TERMINALS] Can't list running MT5 terminals here (%s); using MT5_PATH.", exc)
        return [MT5_PATH] if MT5_PATH else []
    paths, seen = [], set()
    for line in (out or "").splitlines():
        path = line.strip()
        if path.lower().endswith(TERMINAL_EXE) and path.lower() not in seen:
            seen.add(path.lower())
            paths.append(path)
    if seen != _terminals_seen:
        _terminals_seen = seen
        log.info("[TERMINALS] %d MT5 running: %s", len(paths), ", ".join(paths) or "none")
    return paths


def attach_terminal(path):
    """Connect to a running terminal as it is (no login, nothing switched); its account, or None."""
    with MT5_LOCK:
        try:
            mt5.shutdown()
        except Exception:
            pass
        if not mt5.initialize(path=path, timeout=15000):
            log.warning("[TERMINALS] Could not attach to %s: %s", path, mt5_error_text())
            return None
        info = mt5.account_info()
    return info if info and info.login else None


def discover_account(info):
    """The journal's account for a terminal's login (created on first sight, no password)."""
    global JWT_TOKEN
    real_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2)
    payload = {
        "login": str(info.login), "server": str(info.server or ""),
        "company": str(getattr(info, "company", "") or ""), "name": str(getattr(info, "name", "") or ""),
        "accountType": "live" if info.trade_mode == real_mode else "demo",
    }
    url = f"{API_BASE}/sync-agent/trading-accounts/discover"
    try:
        resp = requests.post(url, json=payload, headers={"Authorization": f"Bearer {JWT_TOKEN}"}, timeout=API_TIMEOUT)
        if resp.status_code == 401 and get_jwt_token():
            resp = requests.post(url, json=payload, headers={"Authorization": f"Bearer {JWT_TOKEN}"}, timeout=API_TIMEOUT)
        resp.raise_for_status()
        return resp.json().get("account")
    except requests.RequestException as exc:
        log.warning("[TERMINALS] Could not register %s %s: %s", info.server, info.login, exc)
        return None


def mt5_error_text():
    """The last MT5 error, in words that say what to do about it."""
    code, message = mt5.last_error()
    if code == mt5.RES_E_AUTH_FAILED:
        return f"MT5 is open but not logged in to an account ({message}). Log in with File > Login to Trade Account."
    return f"({code}, {message!r}) -- is MetaTrader 5 running?"


def connect_mt5(account=None):
    """Attach to the running MT5 this account is logged in to. Never logs in."""
    if account is not None:
        activate_account(account)
    if not ACTIVE_ACCOUNT or not ACTIVE_ACCOUNT.get("terminalPath"):
        log.error("[MT5] No active account open in a running MT5.")
        return False
    terminal_path = ACTIVE_ACCOUNT["terminalPath"]
    info = attach_terminal(terminal_path)
    if not info or str(info.login) != str(ACTIVE_ACCOUNT.get("terminalLogin")):
        log.error("[MT5] %s is no longer logged in to %s", ACTIVE_ACCOUNT.get("label"), terminal_path)
        return False
    real_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2)
    if ACTIVE_ACCOUNT.get("requireRealAccount") and info.trade_mode != real_mode:
        log.critical("[MT5] Refusing to sync. Account %s on %s is not REAL.", info.login, info.server)
        return False
    log.info("[MT5] Attached | Login: %s | Server: %s | Balance: %.2f | %s", info.login, info.server, info.balance, terminal_path)
    return True


def mt5_ipc_failed():
    """Return True when the terminal's Python IPC channel is unavailable."""
    code, message = mt5.last_error()
    return code <= -10000 or "IPC" in str(message).upper()


def reconnect_mt5(reason):
    """Rebuild the terminal IPC session while keeping every MT5 call serialized."""
    with MT5_LOCK:
        log.warning("[MT5] Reconnecting terminal after %s...", reason)
        try:
            mt5.shutdown()
        except Exception:
            pass
        time.sleep(0.5)
        return connect_mt5()


def history_deals_get_with_retry(*args, **kwargs):
    """Read deal history and retry once after an MT5 IPC reconnect."""
    with MT5_LOCK:
        deals = mt5.history_deals_get(*args, **kwargs)
        if deals is None and mt5_ipc_failed():
            error = mt5.last_error()
            if reconnect_mt5(f"history_deals_get failure {error}"):
                deals = mt5.history_deals_get(*args, **kwargs)
        return deals


def history_orders_get_with_retry(*args, **kwargs):
    """Read order history (for the sl/tp set on the entry order) with the same retry behavior."""
    with MT5_LOCK:
        orders = mt5.history_orders_get(*args, **kwargs)
        if orders is None and mt5_ipc_failed():
            error = mt5.last_error()
            if reconnect_mt5(f"history_orders_get failure {error}"):
                orders = mt5.history_orders_get(*args, **kwargs)
        return orders


def get_account_balance():
    """Return current account balance from MT5."""
    info = mt5.account_info()
    return info.balance if info else 0.0


def get_account_type():
    """Return the journal account classification reported by the connected MT5 account."""
    info = mt5.account_info()
    if not info:
        return ""
    real_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2)
    return "live" if info.trade_mode == real_mode else "demo"


def get_account_identity():
    """Return the stable identity of the MT5 account connected to this agent."""
    info = mt5.account_info()
    if not info:
        return {"accountKey": "", "accountName": "", "accountType": "", "tradingAccountId": ""}
    real_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2)
    account_type = "live" if info.trade_mode == real_mode else "demo"
    return {
        "accountKey": (ACTIVE_ACCOUNT or {}).get("accountKey", ""),
        "accountName": (ACTIVE_ACCOUNT or {}).get("label", "MT5 account"),
        "accountType": account_type,
        "tradingAccountId": (ACTIVE_ACCOUNT or {}).get("id", ""),
    }


def fetch_trading_accounts():
    """Download enabled account credentials over the authenticated TLS API channel."""
    global JWT_TOKEN
    if not JWT_TOKEN and not get_jwt_token():
        return []
    headers = {"Authorization": f"Bearer {JWT_TOKEN}"}
    try:
        resp = requests.get(f"{API_BASE}/sync-agent/trading-accounts", headers=headers, timeout=API_TIMEOUT)
        if resp.status_code == 401 and get_jwt_token():
            headers = {"Authorization": f"Bearer {JWT_TOKEN}"}
            resp = requests.get(f"{API_BASE}/sync-agent/trading-accounts", headers=headers, timeout=API_TIMEOUT)
        resp.raise_for_status()
        accounts = resp.json().get("accounts", [])
        ACCOUNT_CACHE.clear()
        ACCOUNT_CACHE.update({account.get("accountKey"): account for account in accounts if account.get("accountKey")})
        return accounts
    except requests.RequestException as exc:
        log.error("[ACCOUNTS] Could not load trading accounts: %s", exc)
        return []


def import_legacy_account():
    """One-time bridge from old MT5_* variables to encrypted database storage."""
    if not (LEGACY_MT5_LOGIN and LEGACY_MT5_PASSWORD and LEGACY_MT5_SERVER and JWT_TOKEN):
        return False
    headers = {"Authorization": f"Bearer {JWT_TOKEN}"}
    payload = {
        "label": "Primary MT5 Account",
        "login": LEGACY_MT5_LOGIN,
        "password": LEGACY_MT5_PASSWORD,
        "server": LEGACY_MT5_SERVER,
        "requireRealAccount": LEGACY_REQUIRE_REAL,
        "symbolAliases": LEGACY_SYMBOL_ALIASES,
    }
    try:
        resp = requests.post(
            f"{API_BASE}/sync-agent/trading-accounts/import-legacy",
            json=payload, headers=headers, timeout=API_TIMEOUT,
        )
        if resp.status_code == 409:
            return False
        resp.raise_for_status()
        log.info("[ACCOUNTS] Imported the legacy MT5 account into encrypted database storage.")
        return True
    except requests.RequestException as exc:
        log.error("[ACCOUNTS] Legacy account import failed: %s", exc)
        return False


def report_account_status(account, status, error="", synced=False):
    if not JWT_TOKEN or not account.get("id"):
        return
    info = mt5.account_info() if status == "connected" else None
    real_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2)
    payload = {
        "status": status,
        "error": str(error)[:500],
        "synced": synced,
        "balance": float(info.balance) if info else None,
        "accountType": ("live" if info and info.trade_mode == real_mode else "demo") if info else "",
    }
    try:
        requests.post(
            f"{API_BASE}/sync-agent/trading-accounts/{account['id']}/status",
            json=payload, headers={"Authorization": f"Bearer {JWT_TOKEN}"}, timeout=API_TIMEOUT,
        ).raise_for_status()
    except requests.RequestException as exc:
        log.warning("[ACCOUNTS] Could not report %s status for %s: %s", status, account.get("label"), exc)


def get_latest_trade_time(account_key=""):
    """Fetch the latest closeTime for this specific MT5 account."""
    global JWT_TOKEN
    if not JWT_TOKEN:
        return None
    try:
        headers = {"Authorization": f"Bearer {JWT_TOKEN}"}
        resp = requests.get(
            f"{API_BASE}/trades/latest-close",
            params={"accountKey": account_key} if account_key else {},
            headers=headers,
            timeout=API_TIMEOUT,
        )
        if resp.ok:
            data = resp.json()
            as_of = data.get("closeTime")
            if as_of:
                clean_ts = as_of.split(".")[0].replace("Z", "+00:00")
                return datetime.fromisoformat(clean_ts)
    except Exception as e:
        log.warning("[SYNC] Could not fetch latest trade time from database: %s", e)
    return None


def get_resync_request():
    """Return True when the dashboard has requested a full MT5 history resync."""
    global JWT_TOKEN
    if not JWT_TOKEN:
        return False
    try:
        headers = {"Authorization": f"Bearer {JWT_TOKEN}"}
        resp = requests.get(f"{API_BASE}/maintenance/resync-request", headers=headers, timeout=API_TIMEOUT)
        if resp.ok:
            data = resp.json()
            return bool(data.get("forceFullSync"))
        log.warning("[SYNC] Could not check resync request: %s", resp.text)
    except Exception as e:
        log.warning("[SYNC] Could not check resync request: %s", e)
    return False


def mark_resync_complete():
    """Clear the dashboard full-resync request after a successful sync cycle."""
    global JWT_TOKEN
    if not JWT_TOKEN:
        return
    try:
        headers = {"Authorization": f"Bearer {JWT_TOKEN}"}
        resp = requests.post(f"{API_BASE}/maintenance/resync-complete", headers=headers, timeout=API_TIMEOUT)
        if resp.ok:
            log.info("[SYNC] Dashboard resync request marked complete.")
        else:
            log.warning("[SYNC] Could not mark resync complete: %s", resp.text)
    except Exception as e:
        log.warning("[SYNC] Could not mark resync complete: %s", e)


def _balance_deal_delta(deal):
    """
    Return the signed balance impact of a deal if it's a deposit/withdrawal/
    credit/correction/bonus/charge (a "balance operation"), or None if it's a
    normal trade deal. MT5 already signs `profit` correctly for these (positive
    for money in, negative for money out), so the raw value is the delta.
    """
    balance_types = {
        getattr(mt5, "DEAL_TYPE_BALANCE", None),
        getattr(mt5, "DEAL_TYPE_CREDIT", None),
        getattr(mt5, "DEAL_TYPE_CORRECTION", None),
        getattr(mt5, "DEAL_TYPE_BONUS", None),
        getattr(mt5, "DEAL_TYPE_CHARGE", None),
    }
    balance_types.discard(None)

    amount = float(getattr(deal, "profit", 0.0) or 0.0)
    if amount == 0:
        return None
    symbol = (getattr(deal, "symbol", "") or "").strip()
    volume = float(getattr(deal, "volume", 0.0) or 0.0)
    position_id = int(getattr(deal, "position_id", 0) or 0)
    is_known_balance_type = deal.type in balance_types
    is_balance_like_row = volume == 0 and position_id == 0 and symbol.lower() in {"", "balance", "credit", "withdrawal", "deposit"}
    if not is_known_balance_type and not is_balance_like_row:
        return None
    return amount


def fetch_deals(from_date=None):
    """
    Fetch closed deals from MT5 history starting from from_date.
    Returns a list of deal dicts ready to POST to the API.
    """
    if from_date is None:
        from_date = datetime(2000, 1, 1, tzinfo=timezone.utc)

    to_date = datetime.now(tz=timezone.utc)

    deals = history_deals_get_with_retry(from_date, to_date)
    if deals is None:
        log.warning("[MT5] history_deals_get returned None: %s", mt5.last_error())
        return []

    # Only process position closes (DEAL_ENTRY_OUT = 1)
    closed = [d for d in deals if d.entry == mt5.DEAL_ENTRY_OUT]
    log.info("[MT5] Fetched %d closed deal(s) from history", len(closed))

    current_balance = get_account_balance()
    account_identity = get_account_identity()

    # Deposits/withdrawals/credits inside this window also move the balance.
    # Reconstructing running balance from trade P&L alone (ignoring these)
    # offsets every historical balance by however much cash moved in between.
    balance_deals = [d for d in deals if _balance_deal_delta(d) is not None]

    # Sort chronologically so we can compute a rolling balance per trade.
    # The running balance after entry N = starting_balance + sum(delta[0..N])
    # across BOTH trade closes and cash-flow events. We derive starting_balance
    # by subtracting the total net effect of everything in this window from
    # the current live balance.
    timeline = (
        [{"time": d.time, "ticket": d.ticket, "delta": float(d.profit) + float(d.commission) + float(d.swap)} for d in closed]
        + [{"time": d.time, "ticket": None, "delta": _balance_deal_delta(d)} for d in balance_deals]
    )
    timeline.sort(key=lambda entry: entry["time"])
    total_net_in_window = sum(entry["delta"] for entry in timeline)
    # Balance before the first entry in this window
    balance_before_window = current_balance - total_net_in_window

    # Walk the combined timeline chronologically, tracking running balance
    # after each entry and recording it for trade tickets specifically.
    running_bal = balance_before_window
    ticket_to_running_bal = {}
    for entry in timeline:
        running_bal += entry["delta"]
        if entry["ticket"] is not None:
            ticket_to_running_bal[entry["ticket"]] = running_bal

    # DEAL_REASON tells us objectively how the trade actually closed (hit its
    # stop, hit its target, closed manually, an EA closed it, or a stop-out) —
    # independent of whatever the trader later types into exitReason. Comparing
    # the two is how a journal catches "I said ManualClose but it was really a
    # stop-out" instead of just trusting self-reporting.
    EXIT_TRIGGER_BY_REASON = {
        getattr(mt5, "DEAL_REASON_SL", None): "SL",
        getattr(mt5, "DEAL_REASON_TP", None): "TP",
        getattr(mt5, "DEAL_REASON_SO", None): "StopOut",
        getattr(mt5, "DEAL_REASON_EXPERT", None): "Expert",
        getattr(mt5, "DEAL_REASON_CLIENT", None): "Manual",
        getattr(mt5, "DEAL_REASON_MOBILE", None): "Manual",
        getattr(mt5, "DEAL_REASON_WEB", None): "Manual",
    }

    symbol_info_cache = {}

    def symbol_contract_info(symbol):
        if symbol not in symbol_info_cache:
            info = mt5.symbol_info(symbol)
            symbol_info_cache[symbol] = {
                "contractSize": float(getattr(info, "trade_contract_size", 0) or 0) if info else 0,
                "tickValue": float(getattr(info, "trade_tick_value", 0) or 0) if info else 0,
                "tickSize": float(getattr(info, "trade_tick_size", 0) or 0) if info else 0,
            }
        return symbol_info_cache[symbol]

    result = []

    for deal in closed:
        # Find the matching open deal to get entry price and open time
        open_deals = history_deals_get_with_retry(position=deal.position_id)
        entry_price = deal.price   # fallback
        open_time   = deal.time    # fallback (unix ts)
        entry_order_ticket = None

        # Determine trade direction from the opening deal type
        direction = "BUY"
        if open_deals:
            open_deal = next((d for d in open_deals if d.entry == mt5.DEAL_ENTRY_IN), None)
            if open_deal:
                entry_price = open_deal.price
                open_time   = open_deal.time
                entry_order_ticket = getattr(open_deal, "order", None)
                direction = "BUY" if open_deal.type == mt5.DEAL_TYPE_BUY else "SELL"
            else:
                direction = "SELL" if deal.type == mt5.DEAL_TYPE_BUY else "BUY"
        else:
            direction = "SELL" if deal.type == mt5.DEAL_TYPE_BUY else "BUY"

        open_dt  = datetime.fromtimestamp(open_time, tz=timezone.utc)
        close_dt = datetime.fromtimestamp(deal.time, tz=timezone.utc)
        duration = int((close_dt - open_dt).total_seconds() / 60)

        # Use per-trade running balance (balance AFTER this trade closed)
        trade_running_balance = ticket_to_running_bal.get(deal.ticket, current_balance)
        # Balance just before this trade closed (used for % calculation)
        balance_before_trade = trade_running_balance - float(deal.profit) - float(deal.commission) - float(deal.swap)
        pnl_pct = (deal.profit / balance_before_trade * 100) if balance_before_trade > 0 else 0

        # The stop/target set on the order that opened this position. If the
        # trader moved the stop after entry, MT5's history API does not expose
        # that revision, so this reflects the plan at entry — which is exactly
        # what should be compared against manuallyIntervened / exitTrigger.
        stop_loss = 0.0
        take_profit = 0.0
        if entry_order_ticket:
            entry_orders = history_orders_get_with_retry(ticket=entry_order_ticket)
            if entry_orders:
                stop_loss = float(getattr(entry_orders[0], "sl", 0) or 0)
                take_profit = float(getattr(entry_orders[0], "tp", 0) or 0)

        # Risk in account currency for the stop distance, computed by MT5's own
        # calculator (correctly handles contract size, tick value, and any
        # quote-currency conversion) rather than hand-rolled point math.
        risk_usd = None
        if stop_loss > 0:
            order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
            try:
                computed_risk = mt5.order_calc_profit(order_type, deal.symbol, float(deal.volume), float(entry_price), stop_loss)
                if computed_risk is not None:
                    risk_usd = round(abs(computed_risk), 2)
            except Exception as exc:
                log.debug("[MT5] order_calc_profit failed for ticket %s: %s", deal.ticket, exc)
        risk_percent = round(risk_usd / balance_before_trade * 100, 4) if risk_usd and balance_before_trade > 0 else None

        contract_info = symbol_contract_info(deal.symbol)

        result.append({
            "dealId":          str(deal.ticket),
            "positionId":      str(deal.position_id),
            "symbol":          deal.symbol,
            "direction":       direction,
            "entryPrice":      float(entry_price),
            "exitPrice":       float(deal.price),
            "lotSize":         float(deal.volume),
            "pnlUSD":          float(deal.profit),
            "pnlPct":          round(pnl_pct, 4),
            "commission":      float(deal.commission),
            "swap":            float(deal.swap),
            "openTime":        open_dt.isoformat(),
            "closeTime":       close_dt.isoformat(),
            "durationMinutes": duration,
            "runningBalance":  round(trade_running_balance, 2),
            "stopLoss":        stop_loss or None,
            "takeProfit":      take_profit or None,
            "riskUSD":         risk_usd,
            "riskPercent":     risk_percent,
            "exitTrigger":     EXIT_TRIGGER_BY_REASON.get(getattr(deal, "reason", None), ""),
            "magic":           int(getattr(deal, "magic", 0) or 0),
            "contractSize":    contract_info["contractSize"] or None,
            "tickValue":       contract_info["tickValue"] or None,
            **account_identity,
        })

    return result


def fetch_account_events(from_date=None):
    """
    Fetch MT5 balance operations such as deposits and withdrawals.
    Returns account event dicts ready to POST to the API.
    """
    if from_date is None:
        from_date = datetime(2000, 1, 1, tzinfo=timezone.utc)

    to_date = datetime.now(tz=timezone.utc)
    deals = history_deals_get_with_retry(from_date, to_date)
    if deals is None:
        log.warning("[MT5] history_deals_get returned None for account events: %s", mt5.last_error())
        return []

    events = []
    account_identity = get_account_identity()
    for deal in deals:
        amount = _balance_deal_delta(deal)
        if amount is None:
            continue

        comment = getattr(deal, "comment", "") or ""
        external_id = getattr(deal, "external_id", "") or ""
        event_type = "deposit" if amount > 0 else "withdrawal"

        note = comment or external_id
        occurred_at = datetime.fromtimestamp(deal.time, tz=timezone.utc)
        log.info(
            "[MT5] Cash-flow detected | ticket=%s | type=%s | amount=%.2f | note=%s",
            deal.ticket,
            deal.type,
            amount,
            note or "-",
        )
        events.append({
            "externalId": str(deal.ticket),
            "type": event_type,
            "amount": abs(amount) if event_type != "adjustment" else amount,
            "currency": "USD",
            "occurredAt": occurred_at.isoformat(),
            "note": note,
            "balanceAfter": None,
            **account_identity,
        })

    log.info("[MT5] Fetched %d account cash-flow event(s) from history", len(events))
    return events


def sync_trades(trades):
    """POST trades to the Node.js API. Returns (inserted, skipped)."""
    global JWT_TOKEN
    if not trades:
        return 0, 0

    if not JWT_TOKEN:
        if not get_jwt_token():
            log.error("[SYNC] Sync aborted -- unauthenticated.")
            return 0, 0

    try:
        headers = {"Authorization": f"Bearer {JWT_TOKEN}"}
        resp = requests.post(
            f"{API_BASE}/sync",
            json={"trades": trades},
            headers=headers,
            timeout=API_TIMEOUT,
        )
        if resp.status_code == 401:
            log.warning("[SYNC] JWT token expired. Re-authenticating...")
            if get_jwt_token():
                headers = {"Authorization": f"Bearer {JWT_TOKEN}"}
                resp = requests.post(
                    f"{API_BASE}/sync",
                    json={"trades": trades},
                    headers=headers,
                    timeout=API_TIMEOUT,
                )
            else:
                return 0, 0

        resp.raise_for_status()
        data = resp.json()
        return data.get("inserted", 0), data.get("skipped", 0)
    except requests.RequestException as e:
        log.error("[SYNC] Failed to POST to API: %s", e)
        return 0, 0


def sync_account_events(events):
    """POST MT5 deposits/withdrawals to the Node.js API. Returns (inserted, skipped)."""
    global JWT_TOKEN
    if not events:
        return 0, 0

    if not JWT_TOKEN:
        if not get_jwt_token():
            log.error("[CASHFLOW] Sync aborted -- unauthenticated.")
            return 0, 0

    try:
        headers = {"Authorization": f"Bearer {JWT_TOKEN}"}
        resp = requests.post(
            f"{API_BASE}/sync-account-events", json={"events": events},
            headers=headers, timeout=API_TIMEOUT,
        )
        if resp.status_code == 401:
            log.warning("[CASHFLOW] JWT token expired. Re-authenticating...")
            if not get_jwt_token():
                return 0, 0
            headers = {"Authorization": f"Bearer {JWT_TOKEN}"}
            resp = requests.post(
                f"{API_BASE}/sync-account-events", json={"events": events},
                headers=headers, timeout=API_TIMEOUT,
            )
        resp.raise_for_status()
        data = resp.json()
        return data.get("inserted", 0), data.get("skipped", 0)
    except requests.RequestException as e:
        log.error("[CASHFLOW] Failed to POST account events to API: %s", e)
        return 0, 0


def sync_account(account, force_full_sync=False):
    """Sync one account's closed trades and cash flows from the MT5 it's open in."""
    try:
        if not connect_mt5(account):
            report_account_status(account, "error", f"{account.get('label', 'Account')} is no longer open in its MT5")
            return
        account_identity = get_account_identity()
        latest_time = None if force_full_sync else get_latest_trade_time(account_identity.get("accountKey", ""))
        if force_full_sync:
            from_date = datetime(2000, 1, 1, tzinfo=timezone.utc)
            log.info("[SYNC] Full history for %s...", account.get("label"))
        elif latest_time:
            from_date = latest_time
            log.info("[SYNC] %s from %s...", account.get("label"), latest_time)
        else:
            from_date = datetime(2000, 1, 1, tzinfo=timezone.utc)
            log.info("[SYNC] First history sync for %s...", account.get("label"))

        with MT5_LOCK:
            trades = fetch_deals(from_date)
            account_events = fetch_account_events(datetime(2000, 1, 1, tzinfo=timezone.utc))
        inserted, skipped = sync_trades(trades)
        events_inserted, events_skipped = sync_account_events(account_events)
        report_account_status(account, "connected", synced=True)
        log.info(
            "[SYNC] %s complete -> trades inserted: %d, existing: %d; cash flows inserted: %d, existing: %d",
            account.get("label"), inserted, skipped, events_inserted, events_skipped,
        )
    except Exception as e:
        log.error("[SYNC] %s failed: %s", account.get("label", "Account"), e)
        report_account_status(account, "error", e)


def main(once=False, full=False):
    log.info("[START] Syncing every %ds", SYNC_INTERVAL)

    if not get_jwt_token():
        log.critical("[START] Could not authenticate -- exiting.")
        return

    while True:
        accounts = fetch_trading_accounts()
        if not accounts and import_legacy_account():
            accounts = fetch_trading_accounts()
        terminals = running_terminals()
        if not terminals:
            log.warning("[TERMINALS] No MT5 running. Open MT5 and log in to the account you want to sync.")

        force_full_sync = full or get_resync_request()

        # Every running MT5, read as it is (copier and prop terminals included).
        synced_here = set()
        for path in terminals:
            info = attach_terminal(path)
            if not info:
                continue
            ident = (str(info.login), str(info.server or "").strip().lower())
            if ident in synced_here:
                continue
            synced_here.add(ident)
            account = discover_account(info)
            if not account or not account.get("enabled", True):
                continue
            sync_account({**account, "terminalPath": path, "terminalLogin": str(info.login)}, force_full_sync)

        if force_full_sync and not full:
            mark_resync_complete()

        if once:
            log.info("[STOP] One-shot sync complete.")
            break

        time.sleep(SYNC_INTERVAL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sync closed MetaTrader 5 trades to the Trade Journal API.")
    parser.add_argument("--once", action="store_true", help="Run one sync cycle and exit.")
    parser.add_argument("--full", action="store_true", help="Ignore latest backend trade time and pull full MT5 history.")
    args = parser.parse_args()
    main(once=args.once, full=args.full)
