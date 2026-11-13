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


def close_splash() -> None:
    """The logo the .exe shows the instant it's opened, before Python has even loaded."""
    try:
        import pyi_splash
        pyi_splash.close()
    except Exception:
        pass


class _OneCrate:
    """One Crate at a time, decided the moment it starts.

    Double-clicking the shortcut again while Crate is still starting used to start a second
    copy that raced the first for the port. Now the first holds a system-wide lock; any later
    launch waits for that copy to answer, brings its window forward, and quits."""

    def __init__(self, data: Path):
        self.data, self.handle = data, None

    def release(self) -> None:
        """Before relaunching into an update, so the new version doesn't wait on this one."""
        if self.handle is None:
            return
        if os.name == "nt":
            import ctypes
            ctypes.windll.kernel32.CloseHandle(self.handle)
        else:
            self.handle.close()
        self.handle = None

    def acquire(self) -> bool:
        if os.name == "nt":
            import ctypes
            k32 = ctypes.windll.kernel32
            self.handle = k32.CreateMutexW(None, False, "Local\\CrateDJ")
            return bool(self.handle) and k32.GetLastError() != 183  # ERROR_ALREADY_EXISTS
        import fcntl
        self.handle = open(self.data / "instance.lock", "w")
        try:
            fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def port(self) -> int:
        try:
            return int((self.data / "port").read_text())
        except (OSError, ValueError):
            return PORT

    def hand_over(self, wait: float = 30.0) -> bool:
        """Bring the running copy forward. False if it never answers (stuck), so this launch
        should start anyway rather than leave you with nothing."""
        end = time.monotonic() + wait
        while time.monotonic() < end:
            other = _running_crate(self.port())
            if other:
                if other.get("window"):
                    _poke(self.port(), "focus")
                else:  # finishing an export with its window closed
                    open_window(f"http://127.0.0.1:{self.port()}/", self.data / "window")
                return True
            time.sleep(0.4)
        return False


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

    # Already running, or still starting? Hand over to it before doing anything else.
    one = _OneCrate(data)
    if not args.headless and not one.acquire():
        close_splash()
        if one.hand_over():
            return
        logging.warning("another Crate holds the lock but never answered; starting anyway")

    # Something else on the port (a stuck copy, or not Crate at all): use the next free one.
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
    (data / "port").write_text(str(args.port))  # where a second launch finds this one
    boot = Boot(data, args.port)
    native = False
    try:
        if not (args.headless or args.no_window):
            native = native_window(url, boot, data)  # on screen at once; blocks until the window closes
        close_splash()  # no-op once our window has taken over
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
        one.release()
        cmd = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, sys.argv[0]]
        extra = [] if native else ["--no-window"]  # the old browser window reconnects by itself
        subprocess.Popen(cmd + ["--port", str(args.port)] + extra, close_fds=True,
                         creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))


def _visible(x, y, w, h) -> bool:
    """Would a window here show on one of this computer's screens? Windows parks minimised
    windows at -32000, and a monitor that's been unplugged leaves positions nowhere: saved
    and reused, either opened Crate where you couldn't see it (only its taskbar preview)."""
    if x is None or y is None or not w or not h or min(x, y) <= -10000:
        return False
    if os.name != "nt":
        return True
    try:
        import ctypes
        from ctypes import wintypes
        # the title bar must be on a screen, or the window can't even be dragged back
        bar = wintypes.RECT(int(x) + 40, int(y), int(x + w) - 40, int(y) + 30)
        return bool(ctypes.windll.user32.MonitorFromRect(ctypes.byref(bar), 0))  # MONITOR_DEFAULTTONULL
    except Exception:
        return True


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
    w, h = max(1080, int(geo.get("width") or 1500)), max(680, int(geo.get("height") or 920))
    x, y = (geo.get("x"), geo.get("y")) if _visible(geo.get("x"), geo.get("y"), w, h) else (None, None)  # None: centred
    first = splash.read_text("utf-8") if splash.is_file() else '<body style="background:#101113"></body>'
    win = webview.create_window("Crate", html=first, width=w, height=h, x=x, y=y, min_size=(1080, 680),
                                background_color="#101113", text_select=False, zoomable=False)

    def remember():
        try:  # never remember a minimised or off-screen spot
            if _visible(win.x, win.y, win.width, win.height):
                state_file.write_text(json.dumps({"width": win.width, "height": win.height, "x": win.x, "y": win.y}), "utf-8")
        except Exception:
            pass

    def on_screen():
        """Belt and braces once shown: anything still off-screen comes to the middle, in front."""
        try:
            if not _visible(win.x, win.y, win.width, win.height):
                win.restore()
                win.move(80, 60)
            bring_forward()
        except Exception:
            logging.exception("couldn't place the window")

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
    win.events.shown += close_splash  # our own window (with its animated splash) takes over
    win.events.shown += on_screen

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
