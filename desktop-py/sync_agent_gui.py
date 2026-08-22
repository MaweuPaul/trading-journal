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
import threading
import tkinter as tk
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

CONFIG_DIR = os.path.join(os.getenv("APPDATA", os.path.expanduser("~")), "TradeJournalSyncAgent")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
DEFAULT_CONFIG = {
    "apiBase": "http://localhost:4000/api",
    "syncSecret": "",
    "syncInterval": 60,
    "requireRealAccount": False,
}

NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


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

        if TRAY_AVAILABLE:
            threading.Thread(target=self._start_tray, daemon=True).start()

    # ---------------------------------------------------------------- UI --
    def _build_ui(self):
        self.root.title(APP_NAME)
        self.root.geometry("640x720")
        self.root.minsize(520, 560)

        header = ttk.Frame(self.root, padding=(16, 14))
        header.pack(fill="x")
        title_box = ttk.Frame(header)
        title_box.pack(side="left")
        ttk.Label(title_box, text=APP_NAME, font=("Segoe UI", 13, "bold")).pack(anchor="w")
        ttk.Label(title_box, text="Runs sync.py in the background — no terminal, no manual .env editing.",
                  foreground="#6b6b6b").pack(anchor="w")
        self.status_var = tk.StringVar(value="Stopped")
        self.status_label = ttk.Label(header, textvariable=self.status_var, font=("Segoe UI", 9, "bold"))
        self.status_label.pack(side="right", anchor="ne")

        main = ttk.Frame(self.root, padding=(16, 0, 16, 16))
        main.pack(fill="both", expand=True)

        # -- Connection card ------------------------------------------------
        conn = ttk.LabelFrame(main, text="Connection", padding=12)
        conn.pack(fill="x", pady=(0, 12))

        ttk.Label(conn, text="Backend API URL").grid(row=0, column=0, sticky="w", pady=(0, 2))
        self.api_base_var = tk.StringVar()
        ttk.Entry(conn, textvariable=self.api_base_var).grid(row=1, column=0, columnspan=2, sticky="ew", pady=(0, 8))

        secret_row = ttk.Frame(conn)
        secret_row.grid(row=2, column=0, columnspan=2, sticky="ew")
        ttk.Label(secret_row, text="Your sync secret").pack(side="left")
        help_link = ttk.Label(secret_row, text=" what's this?", foreground="#3366cc", cursor="hand2")
        help_link.pack(side="left")
        help_link.bind("<Button-1>", self._toggle_help)

        self.sync_secret_var = tk.StringVar()
        secret_entry_row = ttk.Frame(conn)
        secret_entry_row.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(2, 8))
        secret_entry_row.columnconfigure(0, weight=1)
        self.secret_entry = ttk.Entry(secret_entry_row, textvariable=self.sync_secret_var, show="•")
        self.secret_entry.grid(row=0, column=0, sticky="ew")
        ttk.Button(secret_entry_row, text="\U0001F441", width=3, command=self._toggle_secret_visibility).grid(row=0, column=1, padx=(4, 0))

        self.help_text = tk.Message(
            conn, width=560, foreground="#6b6b6b",
            text=("Generate this on the TradeJournal Accounts page under \"Your personal MT5 sync secret.\" "
                  "It authenticates this agent as you specifically — it's never your MT5 password, and "
                  "rotating it there instantly invalidates the old one."),
        )
        # hidden until the user clicks "what's this?"

        ttk.Label(conn, text="Sync interval (seconds)").grid(row=5, column=0, sticky="w", pady=(0, 2))
        self.sync_interval_var = tk.StringVar(value="60")
        ttk.Spinbox(conn, from_=10, to=86400, textvariable=self.sync_interval_var, width=10).grid(row=6, column=0, sticky="w", pady=(0, 8))

        self.require_real_account_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(conn, text="Reject demo accounts (only sync live accounts)",
                        variable=self.require_real_account_var).grid(row=7, column=0, columnspan=2, sticky="w", pady=(0, 8))

        conn.columnconfigure(0, weight=1)

        actions_row = ttk.Frame(conn)
        actions_row.grid(row=8, column=0, columnspan=2, sticky="w")
        ttk.Button(actions_row, text="Save", command=self._save_config).pack(side="left")
        self.save_state_var = tk.StringVar()
        ttk.Label(actions_row, textvariable=self.save_state_var, foreground="#2e7d32").pack(side="left", padx=(8, 0))

        # -- Agent card -------------------------------------------------------
        agent = ttk.LabelFrame(main, text="Agent", padding=12)
        agent.pack(fill="x", pady=(0, 12))
        self.python_status_var = tk.StringVar(value="Checking for Python…")
        self.python_status_label = ttk.Label(agent, textvariable=self.python_status_var)
        self.python_status_label.pack(anchor="w", pady=(0, 8))

        agent_actions = ttk.Frame(agent)
        agent_actions.pack(anchor="w")
        self.install_btn = ttk.Button(agent_actions, text="Install/update dependencies", command=self._install_dependencies)
        self.install_btn.pack(side="left")
        self.start_btn = ttk.Button(agent_actions, text="Start Sync", command=self._start_sync)
        self.start_btn.pack(side="left", padx=(8, 0))
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
            self.help_text.grid(row=4, column=0, columnspan=2, sticky="w", pady=(2, 8))

    def _toggle_secret_visibility(self):
        self.secret_entry.config(show="" if self.secret_entry.cget("show") else "•")

    # ------------------------------------------------------------- config --
    def _load_config_into_form(self):
        config = load_config()
        self.api_base_var.set(config.get("apiBase") or DEFAULT_CONFIG["apiBase"])
        self.sync_secret_var.set(config.get("syncSecret") or "")
        self.sync_interval_var.set(str(config.get("syncInterval") or 60))
        self.require_real_account_var.set(bool(config.get("requireRealAccount")))

    def _current_config(self):
        try:
            interval = max(10, int(self.sync_interval_var.get()))
        except ValueError:
            interval = 60
        return {
            "apiBase": self.api_base_var.get().strip() or DEFAULT_CONFIG["apiBase"],
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

    # ------------------------------------------------------------ python --
    def _check_python(self):
        def worker():
            found = resolve_python()
            def update():
                if found:
                    self.python_status_var.set(f"Python detected ({found}).")
                    self.python_status_label.config(foreground="#2e7d32")
                else:
                    self.python_status_var.set("Python was not found. Install Python 3 from python.org, then reopen this app.")
                    self.python_status_label.config(foreground="#c0392b")
            self.root.after(0, update)
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
        python = resolve_python()
        if not python:
            self._append_log("Error: Python was not found on this machine. Install Python 3 from python.org, then try again.")
            return

        self.sync_stopped_by_user = False
        self.restart_attempts = 0
        self.root.after(0, lambda: self._set_status("starting"))
        self._append_log(f"Starting sync.py with {python}...")
        self._spawn_sync(python, config)

    def _spawn_sync(self, python, config):
        env = {
            **os.environ,
            "API_BASE": config["apiBase"],
            "SYNC_SECRET": config["syncSecret"],
            "SYNC_INTERVAL": str(config["syncInterval"]),
            "MT5_REQUIRE_REAL_ACCOUNT": "true" if config["requireRealAccount"] else "false",
        }
        try:
            self.sync_process = subprocess.Popen(
                [python, "-u", SYNC_PY_PATH],
                cwd=os.path.dirname(SYNC_PY_PATH),
                env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, creationflags=NO_WINDOW,
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
        config = load_config()
        python = resolve_python()
        if not python:
            self._append_log("Error: Python was not found on this machine.")
            self._set_status("stopped")
            return
        self._spawn_sync(python, config)

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
