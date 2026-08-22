"""Builds the TradeJournal Sync Agent into a single-file Windows .exe.

Usage:
    python build.py

Produces dist/TradeJournal Sync Agent.exe -- a few MB, since it's just the
Python interpreter + Tkinter + this script, not an entire Chromium runtime.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICON_PNG = os.path.join(HERE, "assets", "icon.png")
ICON_ICO = os.path.join(HERE, "assets", "icon.ico")


def ensure_ico():
    if os.path.exists(ICON_ICO):
        return
    from PIL import Image
    img = Image.open(ICON_PNG)
    img.save(ICON_ICO, sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
    print(f"Generated {ICON_ICO}")


def main():
    ensure_ico()
    sync_py = os.path.join(ROOT, "sync.py")
    requirements_txt = os.path.join(ROOT, "requirements.txt")

    args = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--windowed",
        "--name", "TradeJournal Sync Agent",
        "--icon", ICON_ICO,
        "--add-data", f"{sync_py}{os.pathsep}.",
        "--add-data", f"{requirements_txt}{os.pathsep}.",
        "--add-data", f"{os.path.join(HERE, 'assets')}{os.pathsep}assets",
        os.path.join(HERE, "sync_agent_gui.py"),
    ]
    subprocess.run(args, cwd=HERE, check=True)


if __name__ == "__main__":
    main()
