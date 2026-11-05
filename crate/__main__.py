"""Launcher: start the engine and open the UI in its own app window."""
from __future__ import annotations

import argparse
import logging
import multiprocessing
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

PORT = 47800


def home() -> Path:
    base = os.environ.get("CRATE_HOME") or (Path(os.environ["APPDATA"]) / "Crate" if os.name == "nt" and
                                             os.environ.get("APPDATA") else Path.home() / ".crate")
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _edge() -> str | None:
    if os.name != "nt":
        return shutil.which("chromium") or shutil.which("google-chrome")
    for env in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        for exe in (r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe"):
            p = Path(os.environ.get(env, "")) / exe
            if p.is_file():
                return str(p)
    return None


def _in_use(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def open_window(url: str, profile: Path) -> subprocess.Popen | None:
    browser = _edge()
    if browser:
        return subprocess.Popen([browser, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run",
                                 "--no-default-browser-check", "--window-size=1500,920", "--disable-features=Translate"])
    webbrowser.open(url)
    return None


def main() -> None:
    multiprocessing.freeze_support()
    ap = argparse.ArgumentParser(prog="crate")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--headless", action="store_true", help="serve only, don't open a window")
    ap.add_argument("--no-window", action="store_true", help=argparse.SUPPRESS)  # restart after an update
    args = ap.parse_args()
    url = f"http://127.0.0.1:{args.port}/"
    data = home()
    # The windowed .exe has no console: send output and crashes to a log file instead.
    log = data / "crate.log"
    if log.is_file() and log.stat().st_size > 2_000_000:
        log.replace(data / "crate.old.log")
    if sys.stdout is None or getattr(sys, "frozen", False):
        sys.stdout = sys.stderr = open(log, "a", encoding="utf-8", buffering=1)
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if _in_use(args.port):  # already running: just bring up another window
        open_window(url, data / "window")
        return

    try:
        from .server import serve
        httpd, app = serve(data, args.port)
    except Exception as e:
        logging.exception("startup failed")
        _alert(f"Crate couldn't start: {e}\n\nDetails are in {data / 'crate.log'}")
        return
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    logging.info("running at %s, library %s", url, data)
    if not (args.headless or args.no_window):
        open_window(url, data / "window")
    try:
        # Browser launchers hand off to another process and exit at once, so the
        # window's lifetime is tracked through the page itself: it says goodbye on
        # close (a reload says hello again within a second), and polls while open.
        started = time.monotonic()
        while True:
            time.sleep(1)
            if app.restart:
                time.sleep(0.5)  # let the update reply reach the window
                break
            if args.headless or app.jobs.snapshot()["running"]:
                continue
            now = time.monotonic()
            gone = app.closed_at and now - app.closed_at > 4 and app.last_seen <= app.closed_at
            idle = now - app.last_seen > 600 and now - started > 90
            if gone or idle:
                break
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        httpd.server_close()
        if app.jobs._pool:
            app.jobs._pool.shutdown(cancel_futures=True)
        logging.info("stopped")
    if app.restart:  # relaunch into the new version; the open window reconnects by itself
        cmd = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, sys.argv[0]]
        subprocess.Popen(cmd + ["--port", str(args.port), "--no-window"], close_fds=True,
                         creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))


def _alert(msg: str) -> None:
    if os.name == "nt":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, msg, "Crate", 0x10)
    else:
        print(msg, file=sys.stderr)


if __name__ == "__main__":
    main()
