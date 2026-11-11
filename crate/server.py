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

# Fixed types for the app's own files. Windows guesses from the registry, where .js is
# sometimes text/plain, and browsers refuse to run a module served that way.
WEB_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
             ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json"}

from . import __version__, audio, native, rbxml, setbuilder, smart, soulseek, store, updater, updates
from .export import usb
from .jobs import Jobs, workers
from .library import Library

WEB = Path(__file__).resolve().parent / "web"  # next to this module, so updates bring their own UI


def pick(kind: str) -> str:
    """Native Windows picker via PowerShell (no GUI toolkit needed). '' if cancelled."""
    if os.name != "nt":
        return ""
    if kind == "folder":
        script = ("Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;"
                  "$d.Description='Choose a music folder';$d.UseDescriptionForTitle=$true;"
                  "if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}")
    else:
        script = ("Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.OpenFileDialog;"
                  "$d.Filter='rekordbox collection (*.xml)|*.xml';"
                  "if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.FileName)}")
    out = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", script], capture_output=True,
                         text=True, encoding="utf-8", creationflags=audio.NO_WINDOW)
    return out.stdout.strip()


UPDATE_EVERY_S = 6 * 3600


def index_page() -> bytes:
    """index.html with every script module announced up front (modulepreload), so the browser
    fetches them all at once instead of discovering them one import at a time."""
    mods = sorted(p.relative_to(WEB).as_posix() for p in (WEB / "js").rglob("*.js") if not p.name.endswith(".worklet.js"))
    links = "".join(f'<link rel="modulepreload" href="{m}">' for m in mods)
    return (WEB / "index.html").read_text("utf-8").replace("</head>", links + "</head>", 1).encode("utf-8")


class App:
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
        self.art = Path(tempfile.gettempdir()) / "crate-art"
        self.art.mkdir(exist_ok=True)
        self.watcher = None
        self.restart_watcher()
        self.update_info = None
        threading.Thread(target=self._check_updates, daemon=True).start()
        self.jobs.refresh_cues()  # libraries analysed before the current cue layout catch up once
        self.jobs.refresh_grids()  # ...and before tempo sections

    def restart_watcher(self) -> None:
        if self.watcher:
            self.watcher.stop()
            self.watcher = None
        s = self.lib.settings()
        folder = Path(s["downloads"])
        if s["watch_downloads"] == "1" and folder.is_dir():
            self.watcher = store.DownloadsWatcher(folder, lambda paths: self.jobs.add_files(paths)).start()

    def _check_updates(self) -> None:
        """At launch, then every few hours while Crate stays open."""
        while True:
            self.update_info = updates.check() or self.update_info
            time.sleep(UPDATE_EVERY_S)

    # GET ---------------------------------------------------------------------
    def get_state(self, _):
        n = self.lib.q("SELECT COUNT(*) c, SUM(analysed IS NULL) p, SUM(error IS NOT NULL) e FROM tracks")[0]
        return {"version": __version__, "settings": self.lib.settings(), "workers": workers(),
                "folders": [r["path"] for r in self.lib.q("SELECT path FROM folders")], "update": self.update_info,
                "tracks": n["c"], "pending": n["p"] or 0, "errors": n["e"] or 0, "job": self.jobs.snapshot(),
                "profiles": [{"key": p.key, "label": p.label} for p in usb.PROFILES.values()]}

    def get_tracks(self, _):
        return self.lib.table()

    def get_track(self, tid):
        return self.lib.detail(int(tid))

    # ---- Soulseek, through slskd (Labs)
    def _slsk(self) -> soulseek.Slskd:
        s = self.lib.settings()
        if s["labs_soulseek"] != "1":
            raise ValueError("Soulseek is a Labs feature. Turn it on in Settings first.")
        return soulseek.Slskd(s["slsk_url"], s["slsk_key"])

    def get_slsk(self, _):
        return self._slsk().status()

    def post_slsk_search(self, body):
        return {"id": self._slsk().search(body["q"].strip())}

    def get_slsk_results(self, sid):
        return self._slsk().results(sid)

    def post_slsk_download(self, body):
        self._slsk().download(body["user"], body["filename"], int(body["size"]))
        return {}

    def get_slsk_downloads(self, _):
        """The transfer queue; finished files go into the library (once) and get their track id."""
        c = self._slsk()
        transfers = c.transfers()
        fresh = self.slsk_import.finished(c, transfers)
        if fresh:
            self.jobs.add_files(fresh, "Importing from Soulseek")
        root = c.downloads_dir()
        for t in transfers:
            p = soulseek.locate(root, t["filename"]) if t["state"] == soulseek.DONE_OK else None
            row = self.lib.q("SELECT id, analysed FROM tracks WHERE path = ?", (str(p),)) if p else []
            t["track_id"] = row[0]["id"] if row else None
            t["analysed"] = bool(row and row[0]["analysed"])
        return transfers

    # ---- native audio engine
    def get_engine(self, _):
        return self.engine.info()

    def post_engine_start(self, _):
        origins = [f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}"]
        return {"port": self.engine.start(origins)}

    def post_pcm(self, body):
        t = self.lib.detail(int(body["id"]))
        if not t:
            raise ValueError("That track isn't in the library")
        return self.engine.decode(t["path"], int(body["id"]), int(body["rate"]))

    def get_wishlist(self, _):
        return [{**w, "links": store.links(w["artist"], w["title"])} for w in self.lib.wishlist()]

    def get_links(self, q):
        return store.links(q.get("artist", [""])[0], q.get("title", [""])[0])

    def get_update(self, _):
        return self.update_info or {}

    def get_nodes(self, _):
        return self.lib.nodes()

    def get_job(self, _):
        return self.jobs.snapshot()

    def get_drives(self, _):
        return usb.drives()

    # POST --------------------------------------------------------------------
    def post_update(self, blob: bytes):
        if self.jobs.snapshot()["running"]:
            raise ValueError("Wait for the current job to finish, then install the update.")
        self.engine.stop()  # its exe lives in the folder being replaced
        version = updater.install(blob, self.home)
        self.restart = True  # the launcher restarts Crate once this reply is sent
        return {"version": version}

    def post_bye(self, _):
        self.closed_at = time.monotonic()
        return {}

    def post_folders(self, body):
        path = body.get("path") or pick("folder")
        if not path:
            return {"cancelled": True}
        if not Path(path).is_dir():
            raise ValueError(f"Not a folder: {path}")
        self.lib.x("INSERT OR IGNORE INTO folders(path) VALUES(?)", (str(Path(path)),))
        self.jobs.scan([str(Path(path))])
        return {"path": path}

    def post_folders_remove(self, body):
        self.lib.x("DELETE FROM folders WHERE path = ?", (body["path"],))
        return {}

    def post_rescan(self, _):
        self.jobs.scan()
        return {}

    def post_analyse(self, body):
        self.jobs.analyse(body.get("ids"))
        return {}

    def post_track(self, body):
        self.lib.edit(int(body["id"]), body["fields"])
        return self.get_track(body["id"])

    def post_cues(self, body):
        self.lib.set_cues(int(body["id"]), body["cues"])
        return {"cues": self.lib.cues(int(body["id"]))}

    def post_autocues(self, body):
        ids = [int(i) for i in body.get("ids") or [body["id"]]]
        for tid in ids:
            self.lib.x("DELETE FROM cues WHERE track_id = ?", (tid,))
        if len(ids) > 1:
            self.jobs.refresh_cues(ids)
            return {}
        self.lib.restructure(ids[0])
        return {"cues": self.lib.cues(ids[0]), "phrases": self.lib.phrases(ids[0])}

    def post_remove(self, body):
        self.lib.remove([int(i) for i in body["ids"]])
        return {}

    def post_node_create(self, body):
        return {"id": self.lib.create_node(body["name"], int(body.get("parent_id") or 0), bool(body.get("is_folder")),
                                           body.get("rules"))}

    def post_node_update(self, body):
        self.lib.update_node(int(body["id"]), body.get("name"), body.get("parent_id"), body.get("sort"), body.get("rules"))
        return {}

    def post_smart_preview(self, body):
        rules = smart.validate(body["rules"])
        rows = self.lib.rows()
        for t in rows:
            t["issues"] = self.lib.issues(t)
        return {"count": len(smart.evaluate(rules, rows))}

    def post_set(self, body):
        """Build a set and save it as a playlist."""
        pool = None
        if body.get("pool"):
            pool = set(next((n["tracks"] for n in self.lib.nodes() if n["id"] == int(body["pool"])), []))
        tracks = [t for t in self.lib.rows() if t["analysed"] and not t["error"] and (pool is None or t["id"] in pool)]
        ids = setbuilder.build(tracks, int(body["start"]), int(body.get("length", 20)), body.get("arc", "warmup"))
        name = body.get("name") or "New set"
        nid = self.lib.create_node(name, self.lib.folder("Sets"))
        self.lib.set_node_tracks(nid, ids)
        return {"id": nid, "tracks": ids}

    def post_duplicates(self, _):
        self.jobs.duplicates()
        return {}

    def post_relink(self, body):
        path = body.get("path") or pick("folder")
        if not path:
            return {"cancelled": True}
        self.jobs.relink(path)
        return {"path": path}

    def post_history(self, body):
        self.jobs.import_history(body["path"])
        return {}

    def post_wish(self, body):
        if body.get("remove"):
            self.lib.unwish(int(body["remove"]))
            return {}
        return {"id": self.lib.wish(body.get("artist", ""), body.get("title", ""), body.get("note", ""), body.get("track_id"))}

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

    def post_open(self, body):
        store.open_url(body["url"])
        return {}

    def post_update_check(self, _):
        """Check GitHub now (Settings, and the page once it has loaded)."""
        self.update_info = updates.check(strict=True)
        return {"current": __version__, "update": self.update_info}

    def post_update_fetch(self, _):
        info = self.update_info or updates.check()
        if not info or not info.get("update_asset"):
            raise ValueError("No update is available right now.")
        return self.post_update(updates.download(info["update_asset"]))

    def post_node_delete(self, body):
        self.lib.delete_node(int(body["id"]))
        return {}

    def post_node_tracks(self, body):
        self.lib.set_node_tracks(int(body["id"]), [int(i) for i in body["tracks"]])
        return {}

    def post_settings(self, body):
        for k, v in body.items():
            self.lib.set(k, v)
        if {"watch_downloads", "downloads"} & body.keys():
            self.restart_watcher()
        return self.lib.settings()

    def post_export(self, body):
        opts = usb.Options(profile=body.get("profile", "cdj3000"), level=bool(body.get("level", True)),
                           menu_tables=bool(body.get("menu_tables", True)), phrases=bool(body.get("phrases", False)))
        self.lib.set("profile", opts.profile)
        self.lib.set("level", int(opts.level))
        self.jobs.export(body.get("paths") or body["path"], body.get("nodes"), bool(body.get("everything")), opts)
        return {}

    def post_import_rekordbox(self, body):
        path = body.get("path") or pick("xml")
        if not path:
            return {"cancelled": True}

        def run(report):
            res = rbxml.import_xml(self.lib, path, report)
            self.jobs._analyse(res.pop("ids"))
            return res
        self.jobs.run("Importing rekordbox", run)
        return {"path": path}

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


def handler(app: App):
    routes_get = {"state": app.get_state, "tracks": app.get_tracks, "track": app.get_track,
                  "nodes": app.get_nodes, "job": app.get_job, "drives": app.get_drives,
                  "wishlist": app.get_wishlist, "links": app.get_links, "update": app.get_update,
                  "engine": app.get_engine, "slsk": app.get_slsk, "slsk-results": app.get_slsk_results,
                  "slsk-downloads": app.get_slsk_downloads}
    routes_post = {"bye": app.post_bye, "folders": app.post_folders, "folders/remove": app.post_folders_remove, "rescan": app.post_rescan,
                   "analyse": app.post_analyse, "autocues": app.post_autocues, "track": app.post_track, "cues": app.post_cues,
                   "remove": app.post_remove, "node/create": app.post_node_create, "node/update": app.post_node_update,
                   "node/delete": app.post_node_delete, "node/tracks": app.post_node_tracks,
                   "settings": app.post_settings, "export": app.post_export,
                   "import/rekordbox": app.post_import_rekordbox, "set": app.post_set, "smart/preview": app.post_smart_preview,
                   "duplicates": app.post_duplicates, "relink": app.post_relink, "history": app.post_history,
                   "wish": app.post_wish, "open": app.post_open, "reveal": app.post_reveal, "update/fetch": app.post_update_fetch,
                   "engine/start": app.post_engine_start, "pcm": app.post_pcm, "update/check": app.post_update_check,
                   "slsk/search": app.post_slsk_search, "slsk/download": app.post_slsk_download}

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
                fn = routes_get.get(kind)
                if not fn:
                    return self._json({"error": "no route"}, 404)
                arg = parts[2] if len(parts) > 2 else parse_qs(url.query)
                self._json(fn(arg))
            except Exception as e:
                logging.exception("GET %s", self.path)
                self._json({"error": f"{type(e).__name__}: {e}"}, 500)

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
                fn = routes_post.get(name)
                if not fn:
                    return self._json({"error": "no route"}, 404)
                self._json(fn(body))
            except Exception as e:
                logging.exception("POST %s", self.path)
                self._json({"error": f"{type(e).__name__}: {e}"}, 400)

    return H


def serve(home: Path, port: int = 0) -> tuple[ThreadingHTTPServer, App]:
    app = App(home)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler(app))
    httpd.daemon_threads = True
    app.port = httpd.server_address[1]
    return httpd, app
