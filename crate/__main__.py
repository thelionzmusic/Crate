"""Launcher: start the engine and open the UI in its own app window."""
from __future__ import annotations

import argparse
import json
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
    native = False
    try:
        if not (args.headless or args.no_window):
            native = native_window(url, app, data)  # blocks until the window closes
            if not native:
                open_window(url, data / "window")
        if not native:
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
                if gone or (now - app.last_seen > 600 and now - started > 90):
                    break
        while app.jobs.snapshot()["running"] and not app.restart:  # finish an export before quitting
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        app.engine.stop()
        httpd.shutdown()
        httpd.server_close()
        if app.watcher:
            app.watcher.stop()
        if app.jobs._pool:
            app.jobs._pool.shutdown(cancel_futures=True)
        logging.info("stopped")
    if app.restart:  # relaunch into the new version
        cmd = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, sys.argv[0]]
        extra = [] if native else ["--no-window"]  # the old browser window reconnects by itself
        subprocess.Popen(cmd + ["--port", str(args.port)] + extra, close_fds=True,
                         creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))


def native_window(url: str, app, data: Path) -> bool:
    """Run Crate in its own window (WebView2 on Windows). False if that isn't available."""
    try:
        import webview
    except Exception:
        return False
    state_file = data / "window.json"
    try:
        geo = json.loads(state_file.read_text("utf-8"))
    except (OSError, ValueError):
        geo = {}
    win = webview.create_window("Crate", url, width=geo.get("width", 1500), height=geo.get("height", 920),
                                x=geo.get("x"), y=geo.get("y"), min_size=(1080, 680), background_color="#101113",
                                text_select=False, zoomable=False)

    def remember():
        try:
            state_file.write_text(json.dumps({"width": win.width, "height": win.height, "x": win.x, "y": win.y}), "utf-8")
        except Exception:
            pass

    def dark_title_bar():
        if os.name != "nt":
            return
        try:
            import ctypes
            hwnd = win.native.Handle.ToInt32()
            on = ctypes.c_int(1)
            for attr in (20, 19):  # DWMWA_USE_IMMERSIVE_DARK_MODE (Windows 11 / early 10)
                if ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(on), ctypes.sizeof(on)) == 0:
                    break
        except Exception:
            pass

    win.events.closing += remember
    win.events.shown += dark_title_bar

    def watch_restart():
        while not app.restart:
            time.sleep(0.4)
        time.sleep(0.5)
        win.destroy()

    try:
        webview.start(watch_restart, gui="edgechromium" if os.name == "nt" else None,
                      private_mode=False, storage_path=str(data / "webview"))
    except Exception:
        logging.exception("native window unavailable; using the browser window")
        return False
    return True


def _alert(msg: str) -> None:
    if os.name == "nt":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, msg, "Crate", 0x10)
    else:
        print(msg, file=sys.stderr)


if __name__ == "__main__":
    main()
