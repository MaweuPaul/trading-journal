"""TradeJournal Sync Agent -- native Tkinter rewrite of the Electron app.

Same job as the old Electron wrapper: run sync.py in the background with a
settings window and tray icon instead of hand-editing a .env file. This
version ships as a plain Python script (packaged with PyInstaller) instead
of bundling an entire Chromium runtime, so the installer is a few MB instead
of 100+.
"""
import json
import os
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import tkinter as tk
import urllib.request
from tkinter import ttk
import webbrowser

try:
    import pystray
    from PIL import Image
    TRAY_AVAILABLE = True
except ImportError:
    TRAY_AVAILABLE = False

APP_NAME = "TradeJournal Sync Agent"
SINGLE_INSTANCE_PORT = 47862  # arbitrary fixed port used purely as a lock

IS_FROZEN = getattr(sys, "frozen", False)
BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# sync.py + requirements.txt ship bundled via PyInstaller --add-data in a
# packaged build; in dev mode they still live one directory up at the repo
# root, matching the old Electron layout.
SYNC_PY_PATH = os.path.join(BASE_DIR, "sync.py") if IS_FROZEN else os.path.join(SCRIPT_DIR, "..", "sync.py")
REQUIREMENTS_PATH = os.path.join(BASE_DIR, "requirements.txt") if IS_FROZEN else os.path.join(SCRIPT_DIR, "..", "requirements.txt")
ICON_PATH = os.path.join(BASE_DIR, "assets", "icon.png")
VERSION_PATH = os.path.join(BASE_DIR, "VERSION") if IS_FROZEN else os.path.join(SCRIPT_DIR, "VERSION")

try:
    with open(VERSION_PATH, "r", encoding="utf-8") as _f:
        APP_VERSION = _f.read().strip()
except Exception:
    APP_VERSION = "0.0.0"

CONFIG_DIR = os.path.join(os.getenv("APPDATA", os.path.expanduser("~")), "TradeJournalSyncAgent")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")

# Fixed on purpose -- this app only ever talks to the one production
# TradeJournal backend, so there's no "Backend API URL" field for a user to
# fill in or mistype.
PRODUCTION_API_BASE = "https://trading-journal-x5fe.onrender.com/api"

DEFAULT_CONFIG = {
    "apiBase": PRODUCTION_API_BASE,
    "syncSecret": "",
    "syncInterval": 60,
    "requireRealAccount": False,
}

# Import names (not pip package names) sync.py needs -- used to skip the
# install step once dependencies are already present.
REQUIRED_MODULES = ["MetaTrader5", "requests", "dotenv", "numpy"]

NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

# Official python.org installer -- direct link from python.org's own
# download server, the same file a user would get manually from
# https://www.python.org/downloads/.
PYTHON_VERSION = "3.12.10"
PYTHON_INSTALLER_URL = (
    f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-amd64.exe"
)
# Where python.org's installer puts a per-user install (InstallAllUsers=0) --
# used to add it to this process's PATH immediately after installing, since
# a freshly-installed program isn't visible to already-running processes
# until Windows broadcasts the PATH change (which new processes pick up,
# but this one won't without a restart otherwise).
PYTHON_INSTALL_DIR = os.path.join(
    os.getenv("LOCALAPPDATA", ""), "Programs", "Python", f"Python{PYTHON_VERSION.split('.')[0]}{PYTHON_VERSION.split('.')[1]}"
)


# The packaged app carries sync.py's own Python and packages (MetaTrader5,
# numpy, requests...) inside it, and runs the sync by starting itself again
# with this flag -- nothing to install. Only the dev script needs a system Python.
RUN_SYNC_FLAG = "--run-sync"


def run_bundled_sync(argv):
    """Child-process entry point: run sync.py on the bundled interpreter."""
    import runpy
    # A windowed app has no console; write the log to the pipe the window reads.
    for name, fd in (("stdout", 1), ("stderr", 2)):
        try:
            setattr(sys, name, open(fd, "w", buffering=1, encoding="utf-8", errors="replace", closefd=False))
        except OSError:
            pass
    sys.argv = [SYNC_PY_PATH, *argv]
    runpy.run_path(SYNC_PY_PATH, run_name="__main__")


def sync_command():
    """How to start sync.py: the app itself when packaged, else a system Python."""
    if IS_FROZEN:
        return [sys.executable, RUN_SYNC_FLAG]
    python = resolve_python()
    return [python, "-u", SYNC_PY_PATH] if python else None


def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return {**DEFAULT_CONFIG, **json.load(f)}
    except Exception:
        return dict(DEFAULT_CONFIG)


def save_config(config):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def resolve_python():
    for candidate in ("python", "python3"):
        try:
            subprocess.run(
                [candidate, "--version"],
                capture_output=True, timeout=5, creationflags=NO_WINDOW,
            )
            return candidate
        except Exception:
            continue
    return None


def download_and_install_python(log_fn):
    """Downloads the official python.org installer and runs it silently
    for the current user only (no admin prompt, no dialogs). Returns True
    on success."""
    try:
        log_fn(f"Downloading Python {PYTHON_VERSION} from python.org...")
        installer_path = os.path.join(tempfile.gettempdir(), f"python-{PYTHON_VERSION}-amd64.exe")
        urllib.request.urlretrieve(PYTHON_INSTALLER_URL, installer_path)

        log_fn("Installing Python (this takes a minute, no prompts will appear)...")
        result = subprocess.run(
            [
                installer_path,
                "/quiet",
                "InstallAllUsers=0",
                "PrependPath=1",
                "Include_launcher=0",
            ],
            timeout=300,
        )
        if result.returncode != 0:
            log_fn(f"Python installer exited with code {result.returncode}.")
            return False

        # Make the freshly-installed Python usable immediately in this
        # already-running process, without waiting for a restart.
        scripts_dir = os.path.join(PYTHON_INSTALL_DIR, "Scripts")
        os.environ["PATH"] = PYTHON_INSTALL_DIR + os.pathsep + scripts_dir + os.pathsep + os.environ.get("PATH", "")
        log_fn("Python installed.")
        return True
    except Exception as exc:
        log_fn(f"Error installing Python: {exc}")
        return False


def _version_tuple(version_str):
    parts = []
    for piece in version_str.strip().split("."):
        try:
            parts.append(int(piece))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def check_for_update():
    """Returns the latest version string if it's newer than this build,
    else None. Never raises -- a failed check just means no banner."""
    try:
        url = f"{PRODUCTION_API_BASE}/downloads/sync-agent-version"
        with urllib.request.urlopen(url, timeout=8) as response:
            data = json.loads(response.read().decode("utf-8"))
        latest = data.get("version", "").strip()
        if latest and _version_tuple(latest) > _version_tuple(APP_VERSION):
            return latest
    except Exception:
        pass
    return None


class SyncAgentApp:
    def __init__(self, root):
        self.root = root
        self.log_queue = queue.Queue()
        self.sync_process = None
        self.sync_stopped_by_user = True
        self.restart_attempts = 0
        self.restart_timer = None
        self.status = "stopped"
        self.tray_icon = None

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self._load_config_into_form()
        self._check_python()
        self._poll_log_queue()
        self._check_for_update()

        if TRAY_AVAILABLE:
            threading.Thread(target=self._start_tray, daemon=True).start()

    # ---------------------------------------------------------------- UI --
    def _build_ui(self):
        self.root.title(APP_NAME)
        self.root.geometry("640x720")
        self.root.minsize(520, 560)

        header = ttk.Frame(self.root, padding=(16, 14))
        header.pack(fill="x")
        self.header = header
        title_box = ttk.Frame(header)
        title_box.pack(side="left")
        ttk.Label(title_box, text=APP_NAME, font=("Segoe UI", 13, "bold")).pack(anchor="w")
        ttk.Label(title_box, text="Keeps your trades syncing automatically in the background.",
                  foreground="#6b6b6b").pack(anchor="w")
        self.status_var = tk.StringVar(value="Stopped")
        self.status_label = ttk.Label(header, textvariable=self.status_var, font=("Segoe UI", 9, "bold"))
        self.status_label.pack(side="right", anchor="ne")

        self.update_banner = ttk.Frame(self.root, padding=(16, 6))
        self.update_banner_var = tk.StringVar()
        ttk.Label(self.update_banner, textvariable=self.update_banner_var, foreground="#a8731e").pack(side="left")
        ttk.Button(self.update_banner, text="Get update", command=self._open_update_download).pack(side="left", padx=(10, 0))
        # only shown once a newer version is actually found

        main = ttk.Frame(self.root, padding=(16, 0, 16, 16))
        main.pack(fill="both", expand=True)

        # -- Connection card ------------------------------------------------
        conn = ttk.LabelFrame(main, text="Connection", padding=12)
        conn.pack(fill="x", pady=(0, 12))

        secret_row = ttk.Frame(conn)
        secret_row.grid(row=0, column=0, columnspan=2, sticky="ew")
        ttk.Label(secret_row, text="Your sync key").pack(side="left")
        help_link = ttk.Label(secret_row, text=" what's this?", foreground="#3366cc", cursor="hand2")
        help_link.pack(side="left")
        help_link.bind("<Button-1>", self._toggle_help)

        self.sync_secret_var = tk.StringVar()
        secret_entry_row = ttk.Frame(conn)
        secret_entry_row.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(2, 8))
        secret_entry_row.columnconfigure(0, weight=1)
        self.secret_entry = ttk.Entry(secret_entry_row, textvariable=self.sync_secret_var, show="•")
        self.secret_entry.grid(row=0, column=0, sticky="ew")
        ttk.Button(secret_entry_row, text="\U0001F441", width=3, command=self._toggle_secret_visibility).grid(row=0, column=1, padx=(4, 0))

        self.help_text = tk.Message(
            conn, width=560, foreground="#6b6b6b",
            text=("Find this on the TradeJournal Accounts page under \"Your personal sync key.\" It connects "
                  "this app to your account only — it's never your MT5 password, and generating a new one "
                  "there instantly disables the old one."),
        )
        # hidden until the user clicks "what's this?"

        ttk.Label(conn, text="Sync interval (seconds)").grid(row=3, column=0, sticky="w", pady=(0, 2))
        self.sync_interval_var = tk.StringVar(value="60")
        ttk.Spinbox(conn, from_=10, to=86400, textvariable=self.sync_interval_var, width=10).grid(row=4, column=0, sticky="w", pady=(0, 8))

        self.require_real_account_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(conn, text="Reject demo accounts (only sync live accounts)",
                        variable=self.require_real_account_var).grid(row=5, column=0, columnspan=2, sticky="w", pady=(0, 8))

        conn.columnconfigure(0, weight=1)

        actions_row = ttk.Frame(conn)
        actions_row.grid(row=6, column=0, columnspan=2, sticky="w")
        ttk.Button(actions_row, text="Save", command=self._save_config).pack(side="left")
        self.save_state_var = tk.StringVar()
        ttk.Label(actions_row, textvariable=self.save_state_var, foreground="#2e7d32").pack(side="left", padx=(8, 0))

        # -- Agent card -------------------------------------------------------
        agent = ttk.LabelFrame(main, text="Agent", padding=12)
        agent.pack(fill="x", pady=(0, 12))

        ttk.Label(
            agent,
            text="Before you start: MetaTrader 5 must be installed and open on this computer, logged into "
                 "the account you added on the Accounts page.",
            foreground="#6b6b6b", wraplength=560, justify="left",
        ).pack(anchor="w", pady=(0, 8))

        python_row = ttk.Frame(agent)
        if not IS_FROZEN:  # the packaged app brings its own Python
            python_row.pack(fill="x", pady=(0, 8))
        self.python_status_var = tk.StringVar(value="Checking for Python…")
        self.python_status_label = ttk.Label(python_row, textvariable=self.python_status_var)
        self.python_status_label.pack(side="left")
        self.install_python_btn = ttk.Button(python_row, text="Install Python", command=self._install_python)
        # only shown once we know Python is actually missing

        agent_actions = ttk.Frame(agent)
        agent_actions.pack(anchor="w")
        self.install_btn = ttk.Button(agent_actions, text="Install/update dependencies", command=self._install_dependencies)
        if not IS_FROZEN:
            self.install_btn.pack(side="left", padx=(0, 8))
        self.start_btn = ttk.Button(agent_actions, text="Start Sync", command=self._start_sync)
        self.start_btn.pack(side="left")
        self.stop_btn = ttk.Button(agent_actions, text="Stop", command=self._stop_sync, state="disabled")
        self.stop_btn.pack(side="left", padx=(8, 0))

        # -- Log card ---------------------------------------------------------
        log_frame = ttk.LabelFrame(main, text="Activity Log", padding=8)
        log_frame.pack(fill="both", expand=True)
        log_scroll = ttk.Scrollbar(log_frame)
        log_scroll.pack(side="right", fill="y")
        self.log_text = tk.Text(log_frame, wrap="word", state="disabled", font=("Consolas", 9),
                                 yscrollcommand=log_scroll.set)
        self.log_text.pack(fill="both", expand=True)
        log_scroll.config(command=self.log_text.yview)

    def _toggle_help(self, _event=None):
        if self.help_text.winfo_manager():
            self.help_text.grid_forget()
        else:
            self.help_text.grid(row=2, column=0, columnspan=2, sticky="w", pady=(2, 8))

    def _toggle_secret_visibility(self):
        self.secret_entry.config(show="" if self.secret_entry.cget("show") else "•")

    # ------------------------------------------------------------- config --
    def _load_config_into_form(self):
        config = load_config()
        self.sync_secret_var.set(config.get("syncSecret") or "")
        self.sync_interval_var.set(str(config.get("syncInterval") or 60))
        self.require_real_account_var.set(bool(config.get("requireRealAccount")))

    def _current_config(self):
        try:
            interval = max(10, int(self.sync_interval_var.get()))
        except ValueError:
            interval = 60
        return {
            "apiBase": PRODUCTION_API_BASE,
            "syncSecret": self.sync_secret_var.get().strip(),
            "syncInterval": interval,
            "requireRealAccount": bool(self.require_real_account_var.get()),
        }

    def _save_config(self):
        save_config(self._current_config())
        self.save_state_var.set("Saved")
        self.root.after(1800, lambda: self.save_state_var.set(""))

    # ---------------------------------------------------------------- log --
    def _append_log(self, line):
        self.log_queue.put(line)

    def _poll_log_queue(self):
        while True:
            try:
                line = self.log_queue.get_nowait()
            except queue.Empty:
                break
            at_bottom = self.log_text.yview()[1] >= 0.999
            self.log_text.config(state="normal")
            self.log_text.insert("end", line + "\n")
            self.log_text.config(state="disabled")
            if at_bottom:
                self.log_text.see("end")
        self.root.after(150, self._poll_log_queue)

    # ------------------------------------------------------------ status --
    def _set_status(self, status):
        self.status = status
        self.status_var.set(status.capitalize())
        running = status in ("running", "starting", "restarting")
        self.start_btn.config(state="disabled" if running else "normal")
        self.stop_btn.config(state="normal" if running else "disabled")
        if self.tray_icon:
            self.tray_icon.title = f"{APP_NAME} — {status}"
            self._rebuild_tray_menu()

    # ------------------------------------------------------------ update --
    def _check_for_update(self):
        def worker():
            latest = check_for_update()
            if latest:
                self.root.after(0, lambda: self._show_update_banner(latest))
        threading.Thread(target=worker, daemon=True).start()

    def _show_update_banner(self, latest_version):
        self.update_banner_var.set(f"Update available (v{latest_version} — you have v{APP_VERSION})")
        self.update_banner.pack(fill="x", after=self.header)

    def _open_update_download(self):
        webbrowser.open(f"{PRODUCTION_API_BASE}/downloads/sync-agent")

    # ------------------------------------------------------------ python --
    def _check_python(self):
        if IS_FROZEN:
            return

        def worker():
            found = resolve_python()
            def update():
                if found:
                    self.python_status_var.set(f"Python detected ({found}).")
                    self.python_status_label.config(foreground="#2e7d32")
                    self.install_python_btn.pack_forget()
                else:
                    self.python_status_var.set("Python was not found — required to run the sync.")
                    self.python_status_label.config(foreground="#c0392b")
                    self.install_python_btn.pack(side="left", padx=(10, 0))
            self.root.after(0, update)
        threading.Thread(target=worker, daemon=True).start()

    def _install_python(self):
        self.install_python_btn.config(state="disabled")
        self.python_status_var.set("Installing Python…")
        self._append_log("--- Installing Python ---")

        def worker():
            ok = download_and_install_python(self._append_log)
            self.root.after(0, lambda: self.install_python_btn.config(state="normal"))
            if ok:
                self._check_python()
            else:
                self.root.after(0, lambda: self.python_status_var.set(
                    "Python install failed — try downloading it yourself from python.org."))

        threading.Thread(target=worker, daemon=True).start()

    # ------------------------------------------------------------- deps --
    def _install_dependencies(self):
        self.install_btn.config(state="disabled")
        self._append_log("--- Installing dependencies ---")

        def worker():
            python = resolve_python()
            if not python:
                self._append_log("Error: Python was not found on this machine.")
                self.root.after(0, lambda: self.install_btn.config(state="normal"))
                return
            self._append_log(f"Installing Python dependencies from {REQUIREMENTS_PATH}...")
            try:
                proc = subprocess.Popen(
                    [python, "-m", "pip", "install", "-r", REQUIREMENTS_PATH],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, creationflags=NO_WINDOW,
                )
                for raw_line in proc.stdout:
                    line = raw_line.rstrip()
                    if line:
                        self._append_log(line)
                proc.wait()
                ok = proc.returncode == 0
                self._append_log("Dependencies installed." if ok else f"pip install failed (code {proc.returncode}).")
            except Exception as exc:
                self._append_log(f"Error: {exc}")
            self.root.after(0, lambda: self.install_btn.config(state="normal"))

        threading.Thread(target=worker, daemon=True).start()

    # ------------------------------------------------------------- sync --
    def _start_sync(self):
        self._save_config()
        self._append_log("--- Starting sync ---")
        threading.Thread(target=self._start_sync_worker, daemon=True).start()

    def _start_sync_worker(self):
        if self.sync_process is not None:
            return
        config = load_config()
        if not config.get("syncSecret"):
            self._append_log("Error: Add your sync secret first (from the Accounts page in TradeJournal).")
            return
        if not os.path.exists(SYNC_PY_PATH):
            self._append_log(f"Error: sync.py not found at {SYNC_PY_PATH}")
            return
        if not IS_FROZEN:
            python = resolve_python()
            if not python:
                self._append_log("Error: Python was not found on this machine. Install Python 3 from python.org, then try again.")
                return
            if self._dependencies_missing(python):
                self._append_log("Setting things up for the first time — this only happens once...")
                if not self._run_pip_install(python):
                    self._append_log("Error: setup failed. Try again, or check your internet connection.")
                    return

        self.sync_stopped_by_user = False
        self.restart_attempts = 0
        self.root.after(0, lambda: self._set_status("starting"))
        self._append_log("Starting sync...")
        self._spawn_sync(config)

    def _dependencies_missing(self, python):
        check_code = "import " + ", ".join(REQUIRED_MODULES)
        try:
            result = subprocess.run(
                [python, "-c", check_code],
                capture_output=True, timeout=15, creationflags=NO_WINDOW,
            )
            return result.returncode != 0
        except Exception:
            return True

    def _run_pip_install(self, python):
        try:
            proc = subprocess.Popen(
                [python, "-m", "pip", "install", "-r", REQUIREMENTS_PATH],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, creationflags=NO_WINDOW,
            )
            for raw_line in proc.stdout:
                line = raw_line.rstrip()
                if line:
                    self._append_log(line)
            proc.wait()
            return proc.returncode == 0
        except Exception as exc:
            self._append_log(f"Error: {exc}")
            return False

    def _spawn_sync(self, config):
        command = sync_command()
        if not command:
            self._append_log("Error: Python was not found on this machine.")
            self.root.after(0, lambda: self._set_status("stopped"))
            return
        env = {
            **os.environ,
            "API_BASE": config["apiBase"],
            "SYNC_SECRET": config["syncSecret"],
            "SYNC_INTERVAL": str(config["syncInterval"]),
            "MT5_REQUIRE_REAL_ACCOUNT": "true" if config["requireRealAccount"] else "false",
        }
        try:
            self.sync_process = subprocess.Popen(
                command,
                cwd=os.path.dirname(SYNC_PY_PATH),
                env={**env, "PYTHONIOENCODING": "utf-8"},
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW,
            )
        except Exception as exc:
            self._append_log(f"Error: failed to start sync.py: {exc}")
            self.root.after(0, lambda: self._set_status("stopped"))
            return

        self.root.after(0, lambda: self._set_status("running"))
        threading.Thread(target=self._pump_sync_output, args=(self.sync_process,), daemon=True).start()

    def _pump_sync_output(self, proc):
        for raw_line in proc.stdout:
            line = raw_line.rstrip()
            if line:
                self._append_log(line)
        code = proc.wait()
        if proc is not self.sync_process:
            return  # a newer process has already replaced this one
        self.sync_process = None
        if self.sync_stopped_by_user:
            self.root.after(0, lambda: self._set_status("stopped"))
            return
        self._append_log(f"sync.py exited unexpectedly (code {code}).")
        self.restart_attempts += 1
        delay_ms = min(30000, 2000 * self.restart_attempts)
        self.root.after(0, lambda: self._set_status("restarting"))
        self._append_log(f"Restarting in {round(delay_ms / 1000)}s (attempt {self.restart_attempts})...")
        self.restart_timer = self.root.after(delay_ms, self._restart_sync)

    def _restart_sync(self):
        self._spawn_sync(load_config())

    def _stop_sync(self):
        self.sync_stopped_by_user = True
        if self.restart_timer:
            self.root.after_cancel(self.restart_timer)
            self.restart_timer = None
        self._append_log("--- Stopping sync ---")
        if self.sync_process:
            self._append_log("Stopping sync.py...")
            try:
                self.sync_process.terminate()
            except Exception:
                pass
        else:
            self._set_status("stopped")

    # ---------------------------------------------------------------- tray --
    def _start_tray(self):
        try:
            image = Image.open(ICON_PATH)
        except Exception:
            image = Image.new("RGB", (16, 16), "#d4af37")
        self.tray_icon = pystray.Icon(APP_NAME, image, APP_NAME)
        self._rebuild_tray_menu()
        self.tray_icon.run()

    def _rebuild_tray_menu(self):
        if not self.tray_icon:
            return
        running = self.status == "running"
        self.tray_icon.menu = pystray.Menu(
            pystray.MenuItem(f"Show {APP_NAME}", lambda: self.root.after(0, self._show_window)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Stop Sync" if running else "Start Sync",
                              lambda: self.root.after(0, self._stop_sync if running else self._start_sync)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", lambda: self.root.after(0, self._quit)),
        )

    def _show_window(self):
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def _on_close(self):
        # Closing the window just hides it -- sync (if running) keeps going
        # in the tray, same as a background agent should.
        if TRAY_AVAILABLE:
            self.root.withdraw()
        else:
            self._quit()

    def _quit(self):
        self._stop_sync()
        if self.tray_icon:
            self.tray_icon.stop()
        self.root.after(300, self.root.destroy)


def acquire_single_instance_lock():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", SINGLE_INSTANCE_PORT))
        sock.listen(1)
        return sock
    except OSError:
        return None


def main():
    if RUN_SYNC_FLAG in sys.argv[1:]:
        run_bundled_sync([a for a in sys.argv[1:] if a != RUN_SYNC_FLAG])
        return
    lock = acquire_single_instance_lock()
    if lock is None:
        # Another instance is already running.
        return

    root = tk.Tk()
    try:
        root.iconphoto(True, tk.PhotoImage(file=ICON_PATH) if ICON_PATH.lower().endswith(".png") else None)
    except Exception:
        pass
    app = SyncAgentApp(root)
    root.mainloop()
    lock.close()


if __name__ == "__main__":
    main()
