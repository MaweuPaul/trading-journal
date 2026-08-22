"""Builds the TradeJournal Sync Agent into a Windows app and zips it for
distribution.

Usage:
    python build.py

Uses PyInstaller's --onedir mode (a folder of files) rather than --onefile.
--onefile's self-extracting stub is one of the most common reasons antivirus
engines and browser download scanners flag small, unsigned Python apps as
suspicious; --onedir avoids that stub entirely. The folder is zipped so the
download is still a single file.
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICON_PNG = os.path.join(HERE, "assets", "icon.png")
ICON_ICO = os.path.join(HERE, "assets", "icon.ico")
APP_NAME = "TradeJournal Sync Agent"
# Not named "dist" -- that's git-ignored repo-wide as generic build output.
# This folder is committed on purpose so the built app rides along on
# git-based deploys (e.g. Render) straight to the production server.
RELEASE_DIR = os.path.join(HERE, "release")
BUILD_DIST_DIR = os.path.join(HERE, "dist")  # PyInstaller's own scratch output


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
        "--onedir",
        "--windowed",
        "--name", APP_NAME,
        "--icon", ICON_ICO,
        "--distpath", BUILD_DIST_DIR,
        "--add-data", f"{sync_py}{os.pathsep}.",
        "--add-data", f"{requirements_txt}{os.pathsep}.",
        "--add-data", f"{os.path.join(HERE, 'assets')}{os.pathsep}assets",
        os.path.join(HERE, "sync_agent_gui.py"),
    ]
    subprocess.run(args, cwd=HERE, check=True)

    app_folder = os.path.join(BUILD_DIST_DIR, APP_NAME)
    os.makedirs(RELEASE_DIR, exist_ok=True)
    zip_base = os.path.join(RELEASE_DIR, APP_NAME)
    # Remove any previous zip so shutil doesn't append to a stale one.
    old_zip = zip_base + ".zip"
    if os.path.exists(old_zip):
        os.remove(old_zip)
    shutil.make_archive(zip_base, "zip", app_folder)
    print(f"Built {old_zip}")


if __name__ == "__main__":
    main()
