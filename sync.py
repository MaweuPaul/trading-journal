"""
MT5 -> Trade Journal Sync Script
Connects to MetaTrader 5, fetches closed deals, and POSTs
any new ones to the Node.js backend every SYNC_INTERVAL seconds.

Requirements:
    pip install MetaTrader5 requests python-dotenv

Configuration:
    Copy .env.example to .env in the same directory and fill in your values:
        MT5_LOGIN=YOUR_MT5_ACCOUNT_NUMBER
        MT5_PASSWORD=YOUR_MT5_PASSWORD
        MT5_SERVER=YOUR_MT5_SERVER_NAME
        MT5_REQUIRE_REAL_ACCOUNT=true
        API_BASE=http://localhost:4000/api
        API_TIMEOUT=60
        SYNC_INTERVAL=60
        USER_EMAIL=YOUR_ADMIN_EMAIL
        USER_PASSWORD=YOUR_ADMIN_PASSWORD
"""

import time
import logging
import argparse
from datetime import datetime, timezone
from dotenv import load_dotenv
import os
import requests
import MetaTrader5 as mt5

load_dotenv()

# -- Config -------------------------------------------------------------------
MT5_LOGIN    = int(os.getenv("MT5_LOGIN", "0"))
MT5_PASSWORD = os.getenv("MT5_PASSWORD", "")
MT5_SERVER   = os.getenv("MT5_SERVER", "")
MT5_REQUIRE_REAL_ACCOUNT = os.getenv("MT5_REQUIRE_REAL_ACCOUNT", "true").lower() in {"1", "true", "yes", "on"}
API_BASE      = os.getenv("API_BASE", "http://localhost:4000/api")
API_TIMEOUT   = int(os.getenv("API_TIMEOUT", "60"))
SYNC_INTERVAL = int(os.getenv("SYNC_INTERVAL", "60"))  # seconds
USER_EMAIL    = os.getenv("USER_EMAIL", "")
USER_PASSWORD = os.getenv("USER_PASSWORD", "")

JWT_TOKEN = None

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("MT5Sync")


def get_jwt_token():
    """Authenticate with user email/password against the API and retrieve JWT."""
    global JWT_TOKEN
    if not USER_EMAIL or not USER_PASSWORD:
        log.error("[AUTH] USER_EMAIL and USER_PASSWORD must be configured in .env")
        return False

    try:
        log.info("[AUTH] Authenticating sync pipeline for %s...", USER_EMAIL)
        auth_url = f"{API_BASE.replace('/api', '')}/api/auth/login"
        resp = requests.post(
            auth_url,
            json={"email": USER_EMAIL, "password": USER_PASSWORD},
            timeout=API_TIMEOUT,
        )
        if resp.status_code == 400:
            log.warning("[AUTH] Login failed. Attempting auto-registration for %s...", USER_EMAIL)
            reg_url = f"{API_BASE.replace('/api', '')}/api/auth/register"
            reg_resp = requests.post(
                reg_url,
                json={"name": "MT5 Sync", "email": USER_EMAIL, "password": USER_PASSWORD},
                timeout=API_TIMEOUT,
            )
            if reg_resp.ok:
                data = reg_resp.json()
                JWT_TOKEN = data.get("token")
                log.info("[AUTH] Auto-registered and authenticated successfully.")
                return True
            else:
                log.error("[AUTH] Auto-registration failed: %s", reg_resp.text)
                return False

        resp.raise_for_status()
        data = resp.json()
        JWT_TOKEN = data.get("token")
        log.info("[AUTH] Sync pipeline authenticated successfully.")
        return True
    except Exception as e:
        log.error("[AUTH] Failed to authenticate sync pipeline: %s", e)
        return False


def connect_mt5():
    """Initialize and login to MT5. Returns True on success."""
    if not mt5.initialize():
        log.error("[MT5] mt5.initialize() failed -- is MetaTrader 5 running?")
        return False

    authorized = mt5.login(MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER)
    if not authorized:
        log.error("[MT5] Login failed: %s", mt5.last_error())
        return False

    info = mt5.account_info()
    if not info:
        log.error("[MT5] Connected, but account_info() returned no account details.")
        return False

    if int(info.login) != MT5_LOGIN:
        log.critical(
            "[MT5] Refusing to sync. Connected login %s does not match MT5_LOGIN %s.",
            info.login,
            MT5_LOGIN,
        )
        return False

    real_trade_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2)
    trade_mode_names = {
        getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0): "DEMO",
        getattr(mt5, "ACCOUNT_TRADE_MODE_CONTEST", 1): "CONTEST",
        real_trade_mode: "REAL",
    }
    trade_mode = trade_mode_names.get(info.trade_mode, f"UNKNOWN({info.trade_mode})")

    if MT5_REQUIRE_REAL_ACCOUNT and info.trade_mode != real_trade_mode:
        log.critical(
            "[MT5] Refusing to sync. Account %s on %s is %s, not REAL.",
            info.login,
            info.server,
            trade_mode,
        )
        return False

    log.info("[MT5] Connected | Login: %s | Server: %s | Type: %s | Balance: %.2f",
             info.login, info.server, trade_mode, info.balance)
    return True


def get_account_balance():
    """Return current account balance from MT5."""
    info = mt5.account_info()
    return info.balance if info else 0.0


def get_latest_trade_time():
    """Fetch the closeTime of the latest trade from the database API."""
    global JWT_TOKEN
    if not JWT_TOKEN:
        return None
    try:
        headers = {"Authorization": f"Bearer {JWT_TOKEN}"}
        resp = requests.get(f"{API_BASE}/balance", headers=headers, timeout=API_TIMEOUT)
        if resp.ok:
            data = resp.json()
            as_of = data.get("asOf")
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


def fetch_deals(from_date=None):
    """
    Fetch closed deals from MT5 history starting from from_date.
    Returns a list of deal dicts ready to POST to the API.
    """
    if from_date is None:
        from_date = datetime(2000, 1, 1, tzinfo=timezone.utc)

    to_date = datetime.now(tz=timezone.utc)

    deals = mt5.history_deals_get(from_date, to_date)
    if deals is None:
        log.warning("[MT5] history_deals_get returned None: %s", mt5.last_error())
        return []

    # Only process position closes (DEAL_ENTRY_OUT = 1)
    closed = [d for d in deals if d.entry == mt5.DEAL_ENTRY_OUT]
    log.info("[MT5] Fetched %d closed deal(s) from history", len(closed))

    current_balance = get_account_balance()
    result = []

    for deal in closed:
        # Find the matching open deal to get entry price and open time
        open_deals = mt5.history_deals_get(position=deal.position_id)
        entry_price = deal.price   # fallback
        open_time   = deal.time    # fallback (unix ts)

        # Determine trade direction from the opening deal type
        direction = "BUY"
        if open_deals:
            open_deal = next((d for d in open_deals if d.entry == mt5.DEAL_ENTRY_IN), None)
            if open_deal:
                entry_price = open_deal.price
                open_time   = open_deal.time
                direction = "BUY" if open_deal.type == mt5.DEAL_TYPE_BUY else "SELL"
            else:
                direction = "SELL" if deal.type == mt5.DEAL_TYPE_BUY else "BUY"
        else:
            direction = "SELL" if deal.type == mt5.DEAL_TYPE_BUY else "BUY"

        open_dt  = datetime.fromtimestamp(open_time, tz=timezone.utc)
        close_dt = datetime.fromtimestamp(deal.time, tz=timezone.utc)
        duration = int((close_dt - open_dt).total_seconds() / 60)

        balance_at_close = current_balance - deal.profit
        pnl_pct = (deal.profit / balance_at_close * 100) if balance_at_close > 0 else 0

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
            "runningBalance":  float(current_balance),
        })

    return result


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


def main(once=False, full=False):
    log.info("[START] MT5 Sync Script | Interval: %ds | API: %s", SYNC_INTERVAL, API_BASE)

    if not get_jwt_token():
        log.critical("[START] Could not authenticate -- exiting.")
        return

    if not connect_mt5():
        log.critical("[START] Could not connect to MT5 -- exiting.")
        return

    while True:
        try:
            force_full_sync = full or get_resync_request()
            latest_time = None if force_full_sync else get_latest_trade_time()
            if full:
                log.info("[SYNC] Full history sync requested from command line...")
                from_date = datetime(2000, 1, 1, tzinfo=timezone.utc)
            elif force_full_sync:
                log.info("[SYNC] Dashboard requested full history resync...")
                from_date = datetime(2000, 1, 1, tzinfo=timezone.utc)
            elif latest_time:
                log.info("[SYNC] Latest trade: %s. Syncing incrementally...", latest_time)
                from_date = latest_time
            else:
                log.info("[SYNC] No trades in DB. Syncing full history...")
                from_date = datetime(2000, 1, 1, tzinfo=timezone.utc)

            trades = fetch_deals(from_date)
            inserted, skipped = sync_trades(trades)
            if inserted > 0 or skipped > 0:
                log.info("[SYNC] Complete -> inserted: %d, skipped (dup): %d", inserted, skipped)
            else:
                log.info("[SYNC] Complete -> no new trades")

            if force_full_sync and not full:
                mark_resync_complete()

        except Exception as e:
            log.error("[SYNC] Unexpected error: %s", e)

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
