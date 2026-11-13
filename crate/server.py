"""Local HTTP API + UI host. Binds to 127.0.0.1 only."""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import __version__, audio, desktop, native, prolink, smart, soulseek, store
from .export import usb
from .jobs import Jobs, workers
from .library import Library
from .routes import route, table
from .routes.downloads import DownloadsRoutes
from .routes.live import LiveRoutes
from .routes.pro import ProRoutes
from .routes.sticks import SticksRoutes
from .routes.system import SystemRoutes

WEB = Path(__file__).resolve().parent / "web"  # next to this module, so updates bring their own UI
# Fixed types for the app's own files. Windows guesses from the registry, where .js is
# sometimes text/plain, and browsers refuse to run a module served that way.
WEB_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
             ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json"}




def index_page() -> bytes:
    """index.html with every script module announced up front (modulepreload), so the browser
    fetches them all at once instead of discovering them one import at a time."""
    mods = sorted(p.relative_to(WEB).as_posix() for p in (WEB / "js").rglob("*.js") if not p.name.endswith(".worklet.js"))
    links = "".join(f'<link rel="modulepreload" href="{m}">' for m in mods)
    return (WEB / "index.html").read_text("utf-8").replace("</head>", links + "</head>", 1).encode("utf-8")


class App(ProRoutes, LiveRoutes, DownloadsRoutes, SticksRoutes, SystemRoutes):
    """The library and its playlists; each feature adds its own routes (see routes/)."""

    def __init__(self, home: Path):
        self.lib = Library(home)
        self.jobs = Jobs(self.lib)
        self.home = home
        self.last_seen = time.monotonic()
        self.closed_at = 0.0
        self.restart = False
        self.port = 0
        self.engine = native.Engine(home)
        self.slsk_import = soulseek.Importer()
        self._sync_lock, self._sync_cache = threading.Lock(), (0.0, [])
        self.slsk_host = soulseek.Host(home)
        self.slsk_lock = threading.Lock()
        self.slsk_batch: soulseek.Batch | None = None
        threading.Thread(target=self._slsk_loop, daemon=True).start()
        self.art = Path(tempfile.gettempdir()) / "crate-art"
        self.art.mkdir(exist_ok=True)
        self.watcher = None
        self.restart_watcher()
        self.update_info, self.update_checked = None, -1e9
        threading.Thread(target=self._check_updates, daemon=True).start()
        threading.Thread(target=self.lib.backup_daily, daemon=True).start()
        self.link: prolink.Link | None = None
        threading.Thread(target=self._licence_recheck, daemon=True).start()
        self._link_up()
        self.jobs.catch_up_later()  # cue layout and tempo-section catch-up, once the window is open
        self._slsk_up()
        self.window = None    # the open window, when Crate runs in its own (to bring it forward)
        self.focus = lambda: None


    def restart_watcher(self) -> None:
        if self.watcher:
            self.watcher.stop()
            self.watcher = None
        s = self.lib.settings()
        folder = Path(s["downloads"])
        if s["watch_downloads"] == "1" and folder.is_dir():
            self.watcher = store.DownloadsWatcher(folder, lambda paths: self.jobs.add_files(paths)).start()

    # GET ---------------------------------------------------------------------

    @route("GET", "state")
    def get_state(self, _):
        n = self.lib.q("SELECT COUNT(*) c, SUM(analysed IS NULL) p, SUM(error IS NOT NULL) e FROM tracks")[0]
        return {"version": __version__, "settings": self.public_settings(), "workers": workers(),
                "crashed": os.environ.get("CRATE_CRASHED") == "1",
                "folders": [r["path"] for r in self.lib.q("SELECT path FROM folders")], "update": self.update_info,
                "tracks": n["c"], "pending": n["p"] or 0, "errors": n["e"] or 0, "job": self.jobs.snapshot(),
                "profiles": [{"key": p.key, "label": p.label} for p in usb.PROFILES.values()]}

    @route("GET", "tracks")
    def get_tracks(self, have=None):
        """The track table. Given the version the page already has, only the rows changed since
        (while a job runs the page asks every few seconds, and 20,000 tracks are 6 MB to resend)."""
        v = self.lib.change_seq()
        since = int(have) if isinstance(have, str) and have.isdigit() else None
        if since is not None:
            if since == v:
                return {"same": True, "v": v}
            delta = self.lib.changed_since(since)
            if delta is not None:
                changed, removed = delta
                return {**self.lib.table(changed), "v": v, "delta": True, "removed": removed}
        return {**self.lib.table(), "v": v}

    @route("GET", "track")
    def get_track(self, tid):
        return self.lib.detail(int(tid))



    @route("GET", "wishlist")
    def get_wishlist(self, _):
        return [{**w, "links": store.links(w["artist"], w["title"])} for w in self.lib.wishlist()]

    @route("GET", "links")
    def get_links(self, q):
        return store.links(q.get("artist", [""])[0], q.get("title", [""])[0])

    @route("GET", "nodes")
    def get_nodes(self, _):
        return self.lib.nodes()

    @route("POST", "folders")
    def post_folders(self, body):
        path = body.get("path") or desktop.pick("folder")
        if not path:
            return {"cancelled": True}
        if not Path(path).is_dir():
            raise ValueError(f"Not a folder: {path}")
        self.lib.x("INSERT OR IGNORE INTO folders(path) VALUES(?)", (str(Path(path)),))
        self.jobs.scan([str(Path(path))])
        return {"path": path}

    @route("POST", "folders/remove")
    def post_folders_remove(self, body):
        self.lib.x("DELETE FROM folders WHERE path = ?", (body["path"],))
        return {}

    @route("POST", "rescan")
    def post_rescan(self, _):
        self.jobs.scan()
        return {}

    @route("POST", "analyse")
    def post_analyse(self, body):
        self.jobs.analyse(body.get("ids"))
        return {}

    @route("POST", "track")
    def post_track(self, body):
        self.lib.edit(int(body["id"]), body["fields"])
        return self.get_track(body["id"])

    @route("POST", "cues")
    def post_cues(self, body):
        self.lib.set_cues(int(body["id"]), body["cues"])
        return {"cues": self.lib.cues(int(body["id"]))}

    @route("POST", "autocues")
    def post_autocues(self, body):
        ids = [int(i) for i in body.get("ids") or [body["id"]]]
        for tid in ids:
            self.lib.x("DELETE FROM cues WHERE track_id = ?", (tid,))
        if len(ids) > 1:
            self.jobs.refresh_cues(ids)
            return {}
        self.lib.restructure(ids[0])
        return {"cues": self.lib.cues(ids[0]), "phrases": self.lib.phrases(ids[0])}

    @route("POST", "remove")
    def post_remove(self, body):
        self.lib.remove([int(i) for i in body["ids"]])
        return {}

    @route("POST", "node/create")
    def post_node_create(self, body):
        return {"id": self.lib.create_node(body["name"], int(body.get("parent_id") or 0), bool(body.get("is_folder")),
                                           body.get("rules"))}

    @route("POST", "node/update")
    def post_node_update(self, body):
        self.lib.update_node(int(body["id"]), body.get("name"), body.get("parent_id"), body.get("sort"), body.get("rules"))
        return {}

    @route("POST", "node/delete")
    def post_node_delete(self, body):
        self.lib.delete_node(int(body["id"]))
        return {}

    @route("POST", "node/tracks")
    def post_node_tracks(self, body):
        self.lib.set_node_tracks(int(body["id"]), [int(i) for i in body["tracks"]])
        return {}

    @route("POST", "smart/preview")
    def post_smart_preview(self, body):
        rules = smart.validate(body["rules"])
        rows = self.lib.rows()
        for t in rows:
            t["issues"] = self.lib.issues(t)
        return {"count": len(smart.evaluate(rules, rows))}

    @route("POST", "duplicates")
    def post_duplicates(self, _):
        self.jobs.duplicates()
        return {}

    @route("POST", "relink")
    def post_relink(self, body):
        path = body.get("path") or desktop.pick("folder")
        if not path:
            return {"cancelled": True}
        self.jobs.relink(path)
        return {"path": path}

    @route("POST", "wish")
    def post_wish(self, body):
        if body.get("remove"):
            self.lib.unwish(int(body["remove"]))
            return {}
        return {"id": self.lib.wish(body.get("artist", ""), body.get("title", ""), body.get("note", ""), body.get("track_id"))}

    @route("POST", "reveal")
    def post_reveal(self, body):
        """Show the file in Explorer (Finder elsewhere)."""
        t = self.lib.track(int(body["id"]))
        if not t or not Path(t["path"]).exists():
            raise ValueError("That file isn't where Crate last saw it.")
        if os.name == "nt":
            subprocess.Popen(["explorer", "/select,", str(Path(t["path"]))], creationflags=audio.NO_WINDOW)
        else:
            subprocess.Popen(["xdg-open" if sys.platform.startswith("linux") else "open", str(Path(t["path"]).parent)])
        return {}

    @route("POST", "open")
    def post_open(self, body):
        store.open_url(body["url"])
        return {}

    def public_settings(self) -> dict:
        """Settings for the page: the Soulseek password never leaves Crate, only whether one is saved."""
        s = self.lib.settings()
        s["slsk_has_pass"] = bool(s.pop("slsk_pass", ""))
        for secret in ("licence", "gh_token", "invited"):  # served only through /licence, and the token never
            s.pop(secret, None)
        return s

    @route("POST", "settings")
    def post_settings(self, body):
        body.pop("slsk_has_pass", None)
        for secret in ("licence", "gh_token", "invited"):  # only the licence endpoints set these
            body.pop(secret, None)
        for k, v in body.items():
            self.lib.set(k, v)
        if {"watch_downloads", "downloads"} & body.keys():
            self.restart_watcher()
        if {"labs_soulseek", "slsk_mode", "slsk_dir"} & body.keys():
            self._slsk_up()
        if "prolink" in body:
            self._link_up()
        return self.public_settings()

    # binary -------------------------------------------------------------------
    def wave(self, tid: int) -> bytes:
        f = self.lib.waves / f"{tid}.u8"
        return f.read_bytes() if f.is_file() else b""

    def preview(self, t: dict) -> Path:
        """Lossless FLAC stand-in for formats the browser can't play, cached per file version."""
        f = self.art / f"p{t['id']}-{int(t['mtime'] or 0)}.flac"
        if not f.is_file():
            tmp = f.with_suffix(".part.flac")
            audio.run([audio.tool("ffmpeg"), "-v", "error", "-nostdin", "-y", "-i", t["path"], "-map", "0:a:0",
                       "-c:a", "flac", "-compression_level", "0", str(tmp)])
            tmp.replace(f)
        return f

    def art_file(self, tid: int) -> Path | None:
        t = self.lib.track(tid)
        if not t or not t["has_art"]:
            return None
        f = self.art / f"{tid}-{int(t['mtime'] or 0)}.jpg"
        if f.is_file() or audio.extract_art(t["path"], f, 300):
            return f
        return None


def _say(e: Exception) -> str:
    """What went wrong, for the page: our own messages as written, anything else with its type."""
    return str(e) if isinstance(e, (ValueError, PermissionError)) and str(e) else f"{type(e).__name__}: {e}"


def handler(app: App):
    routes = table(app)

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        # headers and body go out as separate writes; with Nagle on, keep-alive connections
        # stall each response on the client's delayed ACK (40 ms on Linux, up to 200 ms on Windows)
        disable_nagle_algorithm = True

        def log_message(self, *_):
            pass

        def end_headers(self):
            # Cross-origin isolation lets the page share memory with the audio thread
            # (SharedArrayBuffer), so the DJ engine reports positions without messages.
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            super().end_headers()

        def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj, separators=(",", ":")).encode(), "application/json")

        def _file(self, path: Path, ctype: str | None = None):
            size = path.stat().st_size
            ctype = ctype or WEB_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            rng = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
            start, end = 0, size - 1
            if rng and (rng.group(1) or rng.group(2)):
                if rng.group(1):
                    start = int(rng.group(1))
                    end = int(rng.group(2)) if rng.group(2) else size - 1
                else:
                    start = max(0, size - int(rng.group(2)))
            end = min(end, size - 1)
            length = end - start + 1
            self.send_response(206 if rng else 200)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-cache")  # always revalidate, so an update never runs stale modules
            self.send_header("Content-Length", str(length))
            if rng:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            with path.open("rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        return
                    left -= len(chunk)

        def do_GET(self):
            app.last_seen = time.monotonic()
            url = urlparse(self.path)
            parts = url.path.strip("/").split("/")
            try:
                if parts[0] != "api":
                    name = url.path.lstrip("/") or "index.html"
                    if name == "index.html":
                        return self._send(200, index_page(), "text/html; charset=utf-8")
                    f = (WEB / name).resolve()
                    if WEB.resolve() not in f.parents or not f.is_file():
                        return self._send(404, b"not found", "text/plain")
                    return self._file(f)
                kind = parts[1]
                if kind == "audio":
                    t = app.lib.track(int(parts[2]))
                    p = Path(t["path"]) if t else None
                    if not p or not p.is_file():
                        return self._send(404, b"missing", "text/plain")
                    if p.suffix.lower() in (".aif", ".aiff") or t["codec"] == "alac":
                        p = app.preview(t)  # browsers can't decode AIFF or ALAC
                    ctype = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
                             ".wav": "audio/wav"}.get(p.suffix.lower())
                    return self._file(p, ctype)
                if kind == "wave":
                    return self._send(200, app.wave(int(parts[2])), "application/octet-stream")
                if kind == "thumbs":
                    return self._send(200, app.lib.thumbs(), "application/octet-stream")
                if kind == "art":
                    f = app.art_file(int(parts[2]))
                    return self._file(f, "image/jpeg") if f else self._send(404, b"", "text/plain")
                fn = routes.get(("GET", kind))
                if not fn:
                    return self._json({"error": "no route"}, 404)
                arg = parts[2] if len(parts) > 2 else parse_qs(url.query)
                self._json(fn(arg))
            except Exception as e:
                logging.exception("GET %s", self.path)
                self._json({"error": _say(e)}, 500)

        do_HEAD = do_GET

        def do_POST(self):
            name = urlparse(self.path).path.strip("/").removeprefix("api/")
            if name != "bye":
                app.last_seen = time.monotonic()
            try:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n)
                if name == "update":
                    return self._json(app.post_update(raw))
                body = json.loads(raw or b"{}")
                fn = routes.get(("POST", name))
                if not fn:
                    return self._json({"error": "no route"}, 404)
                self._json(fn(body))
            except Exception as e:
                if not isinstance(e, (ValueError, PermissionError)):
                    logging.exception("POST %s", self.path)
                self._json({"error": _say(e)}, 400)

    return H


def serve(home: Path, port: int = 0) -> tuple[ThreadingHTTPServer, App]:
    app = App(home)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler(app))
    httpd.daemon_threads = True
    app.port = httpd.server_address[1]
    return httpd, app
