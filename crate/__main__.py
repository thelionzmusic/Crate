"""Launcher: start the engine and open the UI in its own app window."""
from __future__ import annotations

import argparse
import json
import logging
import multiprocessing
import os
import shutil
import signal
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


def _running_crate(port: int) -> dict | None:
    """What the Crate already on `port` says about itself, or None if nothing answers in time
    (a copy that's stuck, or something else on the port)."""
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/hello", timeout=2.5) as r:
            return json.load(r)
    except Exception:
        return None


def _poke(port: int, path: str) -> None:
    import urllib.request
    try:
        urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/api/{path}", data=b"{}", method="POST",
                                                      headers={"Content-Type": "application/json"}), timeout=2.5).read()
    except Exception:
        pass


class Boot:
    """Starts Crate's server once, from whichever thread asks first (the window's worker
    thread, so the window can be on screen while this runs)."""

    def __init__(self, data: Path, port: int):
        self.data, self.port = data, port
        self.httpd = self.app = self.error = None
        self._lock = threading.Lock()

    def start(self) -> bool:
        with self._lock:
            if self.httpd or self.error:
                return self.error is None
            try:
                from .server import serve
                self.httpd, self.app = serve(self.data, self.port)
            except Exception as e:
                logging.exception("startup failed")
                self.error = e
                return False
            threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
            logging.info("running at http://127.0.0.1:%d/, library %s", self.port, self.data)
            return True


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

    # a polite stop (Ctrl+C, a service manager's SIGTERM) runs the same clean shutdown as closing the window
    def _stop(*_):
        raise KeyboardInterrupt
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _stop)
        except (ValueError, OSError):
            pass

    # Already running? Bring that window forward rather than opening a second Crate. If the
    # copy on the port doesn't answer (stuck, or not Crate at all), start on the next free port.
    if _in_use(args.port):
        other = _running_crate(args.port)
        if other and other.get("window"):
            _poke(args.port, "focus")
            return
        if other:  # running without a window (finishing an export): open one onto it
            open_window(url, data / "window")
            return
        logging.warning("port %d is taken by something that doesn't answer; using another", args.port)
        args.port = next((p for p in range(args.port + 1, args.port + 20) if not _in_use(p)), 0)
        url = f"http://127.0.0.1:{args.port}/"

    # Present while Crate runs, removed on a clean exit: found at launch, it means last time
    # ended in a crash, and Crate offers to send a report.
    running = data / "running"
    crashed = running.is_file()
    running.write_text(str(os.getpid()))
    os.environ["CRATE_CRASHED"] = "1" if crashed else ""
    boot = Boot(data, args.port)
    native = False
    try:
        if not (args.headless or args.no_window):
            native = native_window(url, boot, data)  # on screen at once; blocks until the window closes
        if boot.start() and not native and not (args.headless or args.no_window):
            open_window(url, data / "window")
        if boot.error:
            _alert(f"Crate couldn't start: {boot.error}\n\nDetails are in {data / 'crate.log'}")
            return
        httpd, app = boot.httpd, boot.app
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
                if args.headless or app.jobs.must_finish():
                    continue
                now = time.monotonic()
                gone = app.closed_at and now - app.closed_at > 4 and app.last_seen <= app.closed_at
                if gone or (now - app.last_seen > 600 and now - started > 90):
                    break
        app.jobs.stop()  # analysis and catch-up resume next time; an export or import runs to the end
        while app.jobs.must_finish() and not app.restart:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        app, httpd = boot.app, boot.httpd
        if app:
            httpd.shutdown()  # free the port first, so opening Crate again straight away works
            httpd.server_close()
            app.jobs.stop()
            app.engine.stop()
            app.slsk_host.stop()
            if app.link:
                app.link.stop()
            if app.watcher:
                app.watcher.stop()
            logging.info("stopped")
        running.unlink(missing_ok=True)
    if app and app.restart:  # relaunch into the new version
        cmd = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, sys.argv[0]]
        extra = [] if native else ["--no-window"]  # the old browser window reconnects by itself
        subprocess.Popen(cmd + ["--port", str(args.port)] + extra, close_fds=True,
                         creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))


def native_window(url: str, boot: Boot, data: Path) -> bool:
    """Run Crate in its own window (WebView2 on Windows). False if that isn't available.
    The window opens straight away on a splash; the server starts behind it."""
    try:
        import webview
    except Exception:
        return False
    splash = Path(__file__).resolve().parent / "web" / "splash.html"
    state_file = data / "window.json"
    try:
        geo = json.loads(state_file.read_text("utf-8"))
    except (OSError, ValueError):
        geo = {}
    first = splash.read_text("utf-8") if splash.is_file() else '<body style="background:#101113"></body>'
    win = webview.create_window("Crate", html=first, width=geo.get("width", 1500), height=geo.get("height", 920),
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

    def bring_forward():
        try:
            win.restore()
            win.show()
            win.on_top = True  # Windows won't let a background app take focus; this lifts it anyway
            win.on_top = False
        except Exception:
            logging.exception("couldn't bring the window forward")

    def closed():
        if boot.app:
            boot.app.window, boot.app.focus = None, (lambda: None)

    win.events.closed += closed

    def run():
        if not boot.start():
            win.destroy()  # main() reports the error
            return
        boot.app.window, boot.app.focus = win, bring_forward
        win.load_url(url)
        while not boot.app.restart:
            time.sleep(0.4)
        time.sleep(0.5)
        win.destroy()

    try:
        webview.start(run, gui="edgechromium" if os.name == "nt" else None,
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
