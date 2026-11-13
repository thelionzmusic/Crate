"""Local HTTP API + UI host. Binds to 127.0.0.1 only."""
from __future__ import annotations

import datetime as dt
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

from . import __version__, audio, licence, native, prolink, rbstick, rbxml, setbuilder, smart, soulseek, store, updater, updates
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


def _open_external(url: str) -> None:
    """A link or a mailto: in the system's own browser or mail app, never the Crate window."""
    if os.name == "nt":
        os.startfile(url)  # noqa: S606
    else:
        import webbrowser
        webbrowser.open(url)


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
        self.jobs.refresh_cues()  # libraries analysed before the current cue layout catch up once
        self.jobs.refresh_grids()  # ...and before tempo sections
        self._slsk_up()

    # ---- Crate Pro -------------------------------------------------------------------
    def _licence(self) -> dict:
        try:
            return json.loads(self.lib.settings().get("licence") or "{}")
        except ValueError:
            return {}

    def _save_licence(self, lic: dict) -> None:
        self.lib.set("licence", json.dumps(lic) if lic else "")

    def _licence_recheck(self) -> None:
        lic = self._licence()
        if lic:
            self._save_licence(licence.recheck(lic))
            self._link_up()

    def pro(self, feature: str) -> None:
        if not licence.status(self._licence())["pro"]:
            raise licence.ProRequired(feature)

    def get_licence(self, _):
        s = self.lib.settings()
        st = licence.status(self._licence())
        if st.get("owner"):
            st["invited"] = json.loads(s.get("invited") or "[]")
            st["has_token"] = bool(s.get("gh_token"))
        st["store_url"] = s.get("store_url", "")
        st["features"] = licence.PRO_FEATURES
        return st

    def post_licence_signin(self, body):
        self._save_licence(licence.sign_in(body["email"], body["password"]))
        self._link_up()
        return self.get_licence(None)

    def post_licence_key(self, body):
        self._save_licence(licence.activate_key(body["key"]))
        self._link_up()
        return self.get_licence(None)

    def post_licence_signout(self, _):
        self._save_licence({})
        self._link_up()
        return self.get_licence(None)

    def _owner_token(self) -> str:
        if not licence.status(self._licence()).get("owner"):
            raise PermissionError("Only the owner account can invite testers")
        token = self.lib.settings().get("gh_token", "")
        if not token:
            raise ValueError("Add your GitHub access token first (Settings > Crate Pro)")
        return token

    def post_licence_invite(self, body):
        inv = licence.invite(self._owner_token(), body["email"], "tester")
        invited = [i for i in json.loads(self.lib.settings().get("invited") or "[]") if i["email"] != inv["email"]]
        invited.insert(0, {"email": inv["email"], "date": dt.date.today().isoformat()})
        self.lib.set("invited", json.dumps(invited))
        _open_external(inv["mailto"])  # the invite email, drafted in their mail app, ready to send
        return {**self.get_licence(None), "sent": inv}

    def post_licence_revoke(self, body):
        licence.revoke(self._owner_token(), body["email"])
        invited = [i if i["email"] != body["email"] else {**i, "revoked": True} for i in json.loads(self.lib.settings().get("invited") or "[]")]
        self.lib.set("invited", json.dumps(invited))
        return self.get_licence(None)

    def post_licence_token(self, body):
        token = body.get("token", "").strip()
        if token and not token.startswith(("github_pat_", "ghp_")):
            raise ValueError("That isn't a GitHub access token. They start with github_pat_")
        self.lib.set("gh_token", token)
        return self.get_licence(None)

    def post_get_pro(self, _):
        url = self.lib.settings().get("store_url", "")
        if not url.startswith("https://"):
            raise ValueError("Crate Pro isn't on sale yet")
        _open_external(url)
        return {}

    def _link_up(self) -> None:
        """Follow the CDJs while the setting is on (a Pro feature)."""
        want = self.lib.settings().get("prolink") == "1" and licence.status(self._licence())["pro"]
        if want and not (self.link and self.link.running):
            self.link = prolink.Link(on_play=lambda tid, deck, started: self.lib.log_live_play(tid, started)).start()
        elif not want and self.link:
            self.link.stop()
            self.link = None

    def get_live(self, _):
        if not licence.status(self._licence())["pro"]:
            return {"running": False, "locked": True, "error": str(licence.ProRequired("live")), "decks": [], "log": [], "devices": []}
        if not self.link:
            return {"running": False, "error": None, "decks": [], "log": [], "devices": []}
        snap = self.link.snapshot()
        ids = {d["track"] for d in snap["decks"]} | {e["track"] for e in snap["log"]}
        rows = {i: self.lib.track(i) for i in ids if i}
        brief = lambda i: {k: rows[i][k] for k in ("id", "title", "artist", "bpm", "key", "camelot", "energy")} if rows.get(i) else None  # noqa: E731
        for d in snap["decks"]:
            d["info"] = brief(d["track"])
        for e in snap["log"]:
            e["info"] = brief(e["track"])
        return snap

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
            self.update_checked = time.monotonic()
            time.sleep(UPDATE_EVERY_S)

    # GET ---------------------------------------------------------------------
    # ---- crash reports ---------------------------------------------------------------
    def _report(self, note: str = "") -> dict:
        """Version, system and the end of crate.log, with your user name taken out of paths."""
        import platform
        log = ""
        for name in ("crate.log", "crate.old.log"):
            f = self.home / name
            if f.is_file():
                log = f.read_text("utf-8", "replace")[-6000:]
                break
        log = log.replace(str(Path.home()), "~")
        return {"version": __version__, "system": f"{platform.system()} {platform.release()} ({platform.machine()})",
                "note": note.strip(), "log": log}

    def get_report(self, _):
        return self._report()

    def post_report(self, body):
        """Open a GitHub issue with the report filled in; the person sees it before it's sent."""
        import urllib.parse
        r = self._report(body.get("note", ""))
        text = (f"{r['note'] or 'What were you doing when it happened?'}\n\n**Crate** {r['version']} on {r['system']}\n\n"
                f"<details><summary>Log</summary>\n\n```\n{r['log'][-4500:]}\n```\n</details>")
        url = (f"https://github.com/{updates.REPO}/issues/new?title={urllib.parse.quote('Crash report: ' + r['version'])}"
               f"&body={urllib.parse.quote(text)}")
        _open_external(url)
        return {}

    def post_jserror(self, body):
        """Errors in the page go to crate.log, so a report includes them."""
        logging.error("page: %s at %s\n%s", str(body.get("message", ""))[:500], str(body.get("where", ""))[:200], str(body.get("stack", ""))[:2000])
        return {}

    def get_state(self, _):
        n = self.lib.q("SELECT COUNT(*) c, SUM(analysed IS NULL) p, SUM(error IS NOT NULL) e FROM tracks")[0]
        return {"version": __version__, "settings": self.public_settings(), "workers": workers(),
                "crashed": os.environ.get("CRATE_CRASHED") == "1",
                "folders": [r["path"] for r in self.lib.q("SELECT path FROM folders")], "update": self.update_info,
                "tracks": n["c"], "pending": n["p"] or 0, "errors": n["e"] or 0, "job": self.jobs.snapshot(),
                "profiles": [{"key": p.key, "label": p.label} for p in usb.PROFILES.values()]}

    def get_tracks(self, have=None):
        """The whole track table, or just {"same": true} when the page already has this version:
        while a job runs the page asks every few seconds, and 20,000 tracks are 6 MB to resend."""
        v = str(self.lib.db.total_changes)
        if have == v:
            return {"same": True, "v": v}
        if getattr(self, "_table", (None,))[0] != v:
            self._table = (v, self.lib.table())
        return {**self._table[1], "v": v}

    def get_track(self, tid):
        return self.lib.detail(int(tid))

    # ---- Soulseek, through slskd (Labs)
    def _slsk(self) -> soulseek.Slskd:
        s = self.lib.settings()
        if s["labs_soulseek"] != "1":
            raise ValueError("Soulseek is a Labs feature. Turn it on in Settings first.")
        if s["slsk_mode"] == "external":
            return soulseek.Slskd(s["slsk_url"], s["slsk_key"])
        if self.slsk_host.state != "running":
            raise ValueError({"installing": "Setting up Soulseek…", "starting": "Soulseek is starting…"}.get(
                self.slsk_host.state, self.slsk_host.error or "Sign in to Soulseek in Settings, under Labs"))
        return self.slsk_host.client()

    def _slsk_up(self) -> None:
        """Start (or restart) the built-in slskd in the background, if it's wanted and signed in."""
        s = self.lib.settings()
        if s["labs_soulseek"] == "1" and s["slsk_mode"] == "builtin" and s["slsk_user"] and s["slsk_pass"]:
            threading.Thread(target=self.slsk_host.start, args=(s["slsk_user"], s["slsk_pass"], Path(s["slsk_dir"])), daemon=True).start()
        else:
            self.slsk_host.stop()

    def get_slsk(self, _):
        s, h = self.lib.settings(), self.slsk_host
        out = {"mode": s["slsk_mode"], "state": h.state, "error": h.error, "progress": round(h.progress, 3), "user": s["slsk_user"]}
        if s["slsk_mode"] == "external" or h.state == "running":
            try:
                st = self._slsk().status()
                out.update(state="running", logged_in=st["logged_in"], connecting=st["connecting"], user=st["user"] or s["slsk_user"])
            except (soulseek.SlskdError, ValueError) as e:
                out.update(state="error", error=str(e))
        return out

    def post_slsk_connect(self, body):
        """Save the Soulseek login (built-in mode) and (re)start slskd with it."""
        for k in ("slsk_user", "slsk_pass"):
            if body.get(k):
                self.lib.set(k, body[k].strip())
        self._slsk_up()
        return {}

    def post_slsk_search(self, body):
        return {"id": self._slsk().search(body["q"].strip())}

    def get_slsk_results(self, sid):
        return self._slsk().results(sid)

    def post_slsk_download(self, body):
        """Queue a download; with `playlist`, it joins that playlist once it's downloaded and analysed."""
        self._slsk_queue(body, int(body["playlist"]) if body.get("playlist") else None)
        return {}

    def _slsk_queue(self, src: dict, playlist: int | None) -> None:
        self._slsk().download(src["user"], src["filename"], int(src["size"]))
        if playlist:
            with self.slsk_lock:
                pending = self._pending()
                pending[f'{src["user"]}|{src["filename"]}'] = {"node": playlist, "done": False}
                self.lib.set("slsk_pending", json.dumps(dict(list(pending.items())[-300:])))  # on disk: survives a restart

    def _pending(self) -> dict:
        return json.loads(self.lib.settings().get("slsk_pending") or "{}")

    def _file(self, key: str, track_id: int) -> bool:
        """Put a downloaded track in the playlist it was meant for (once)."""
        with self.slsk_lock:
            pending = self._pending()
            want = pending.get(key)
            if not want or want["done"]:
                return False
            if self.lib.q("SELECT 1 FROM nodes WHERE id = ?", (want["node"],)):
                self.lib.append_to_node(want["node"], track_id)
            want["done"] = True
            self.lib.set("slsk_pending", json.dumps(pending))
            return True

    def _slsk_sync(self, max_age: float = 0.0) -> list[dict]:
        """Import finished downloads (analysed, then filed into their playlist, in one job) and
        annotate the queue with track ids. Runs from a background loop and from the page; one
        at a time, and a pass newer than `max_age` seconds is shared rather than repeated."""
        with self._sync_lock:
            at, cached = self._sync_cache
            if max_age and time.monotonic() - at < max_age:
                return cached
            out = self._slsk_sync_now()
            self._sync_cache = (time.monotonic(), out)
            return out

    def _slsk_sync_now(self) -> list[dict]:
        c = self._slsk()
        transfers = c.transfers()
        root = c.downloads_dir()
        where = self.slsk_import.where(root, transfers)
        fresh = self.slsk_import.finished(where, transfers)
        if fresh:
            keys = {p: f'{t["user"]}|{t["filename"]}' for p, t in fresh.items()}
            self.jobs.add_files(list(fresh), "Importing from Soulseek",
                                after=lambda ids: [self._file(keys[p], tid) for p, tid in ids.items()])
        pending = self._pending()
        names = {r["id"]: r["name"] for r in self.lib.q("SELECT id, name FROM nodes WHERE NOT is_folder AND rules IS NULL")} if pending else {}
        paths = [str(p) for p in where.values() if p]
        known = {}
        for i in range(0, len(paths), 500):  # SQLite caps how many values one query takes
            chunk = paths[i:i + 500]
            known.update({r["path"]: r for r in self.lib.q(
                f"SELECT id, path, analysed FROM tracks WHERE path IN ({','.join('?' * len(chunk))})", chunk)})
        late = False
        for t in transfers:
            p = where.get(t["id"])
            row = known.get(str(p)) if p else None
            t["track_id"] = row["id"] if row else None
            t["analysed"] = bool(row and row["analysed"])
            t["missing"] = t["state"] == soulseek.DONE_OK and p is None  # finished, but the file isn't in the folder
            key = f'{t["user"]}|{t["filename"]}'
            want = pending.get(key)
            t["playlist"] = names.get(want["node"]) if want else None
            # asked for after it was already imported: file it now
            if want and not want["done"] and t["analysed"] and str(p) not in fresh:
                late |= self._file(key, t["track_id"])
        if late:
            self.jobs.submit("Adding to playlist", lambda: {})  # the page reloads playlists when a job ends
        return transfers

    def get_slsk_downloads(self, _):
        return self._slsk_sync(max_age=1.5)

    # batches: a CSV of tracks, found and downloaded one after another in the background
    def post_slsk_batch(self, body):
        if self.slsk_batch and self.slsk_batch.running:
            raise ValueError("A batch is already running. Stop it first, or wait for it to finish.")
        items = soulseek.parse_csv(body["csv"])
        if not items:
            raise ValueError("No tracks found in that file. It needs artist and title columns, or one track per line.")
        self._slsk()  # fail now, not halfway in, if Soulseek isn't ready
        name = (body.get("name") or "Batch").rsplit(".", 1)[0]
        target, label = body.get("playlist"), None
        if target == "new":
            target, label = self.lib.create_node(name, 0, False), name
        elif target:
            target = int(target)
            label = (self.lib.q("SELECT name FROM nodes WHERE id = ?", (target,)) or [{"name": None}])[0]["name"]
        else:
            target = None
        self.slsk_batch = b = soulseek.Batch(name, items, target, label)
        threading.Thread(target=b.run, args=(self._slsk, self._slsk_queue, lambda: self._slsk_sync(max_age=1.0)), daemon=True).start()
        return {"count": len(items), "playlist": target}

    def post_slsk_batch_preview(self, body):
        items = soulseek.parse_csv(body["csv"])
        return {"count": len(items), "sample": items[:8]}

    def post_slsk_batch_stop(self, _):
        if self.slsk_batch:
            self.slsk_batch.cancelled = True
        return {}

    def get_slsk_batch(self, _):
        return self.slsk_batch.snapshot() if self.slsk_batch else {}

    def _slsk_loop(self) -> None:
        """Import finished downloads even while the Downloads tab is closed."""
        while True:
            time.sleep(3)
            s = self.lib.settings()
            if s["labs_soulseek"] != "1" or (s["slsk_mode"] == "builtin" and self.slsk_host.state != "running"):
                continue
            try:
                self._slsk_sync(max_age=1.0)
            except Exception:
                pass  # slskd restarting or unreachable: the next pass catches up

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
        return [{**d, "library": (Path(d["path"]) / "PIONEER" / "rekordbox" / "export.pdb").is_file()} for d in usb.drives()]

    def get_backups(self, _):
        return self.lib.backups()

    # POST --------------------------------------------------------------------
    def post_update(self, blob: bytes):
        if self.jobs.snapshot()["running"]:
            raise ValueError("Wait for the current job to finish, then install the update.")
        self.lib.backup(f"before-{__version__}-update")
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

    def post_suggest(self, body):
        """What to play next after a track. With the CDJs followed, tonight's set is left out."""
        self.pro("suggest")
        played = {e["track"] for e in self.link.snapshot()["log"]} if self.link else set()
        tracks = [t for t in self.lib.rows() if t["analysed"] and not t["error"]]
        return setbuilder.suggest(tracks, int(body["id"]), int(body.get("n", 12)), played)

    def post_set(self, body):
        """Build a set and save it as a playlist."""
        self.pro("setbuilder")
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

    def post_backup(self, body):
        if body.get("restore"):
            if self.jobs.snapshot()["running"]:
                raise ValueError("Wait for the current job to finish, then restore.")
            self.lib.restore(body["restore"])
            return {"restored": body["restore"]}
        return {"name": self.lib.backup("manual")}

    def post_stick_check(self, body):
        self.jobs.check_stick(body["path"])
        return {}

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

    def post_update_check(self, body):
        """Check GitHub now (Settings). quiet (the page settling after launch): reuse a check
        from the last quarter hour, so a launch costs GitHub one request, not two."""
        if body.get("quiet") and time.monotonic() - self.update_checked < 900:
            return {"current": __version__, "update": self.update_info}
        self.update_info = updates.check(strict=not body.get("quiet"))
        self.update_checked = time.monotonic()
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

    def public_settings(self) -> dict:
        """Settings for the page: the Soulseek password never leaves Crate, only whether one is saved."""
        s = self.lib.settings()
        s["slsk_has_pass"] = bool(s.pop("slsk_pass", ""))
        for secret in ("licence", "gh_token", "invited"):  # served only through /licence, and the token never
            s.pop(secret, None)
        return s

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

    def post_export(self, body):
        opts = usb.Options(profile=body.get("profile", "cdj3000"), level=bool(body.get("level", True)),
                           menu_tables=bool(body.get("menu_tables", True)), phrases=bool(body.get("phrases", False)))
        self.lib.set("profile", opts.profile)
        self.lib.set("level", int(opts.level))
        self.jobs.export(body.get("paths") or body["path"], body.get("nodes"), bool(body.get("everything")), opts)
        return {}

    def post_import_stick(self, body):
        self.pro("import")
        root = body["path"]
        dest = body.get("dest") or str(Path.home() / "Music" / "Crate" / "From rekordbox")

        def run(report):
            res = rbstick.import_stick(self.lib, root, dest, report)
            self.jobs._analyse(res.pop("ids"))
            return {**res, "dest": dest}
        self.jobs.run("Importing rekordbox stick", run)
        return {"dest": dest}

    def post_import_rekordbox(self, body):
        self.pro("import")
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
                  "nodes": app.get_nodes, "job": app.get_job, "drives": app.get_drives, "backups": app.get_backups,
                  "wishlist": app.get_wishlist, "live": app.get_live, "licence": app.get_licence, "report": app.get_report, "links": app.get_links, "update": app.get_update,
                  "engine": app.get_engine, "slsk": app.get_slsk, "slsk-results": app.get_slsk_results,
                  "slsk-downloads": app.get_slsk_downloads, "slsk-batch": app.get_slsk_batch}
    routes_post = {"bye": app.post_bye, "folders": app.post_folders, "folders/remove": app.post_folders_remove, "rescan": app.post_rescan,
                   "analyse": app.post_analyse, "autocues": app.post_autocues, "track": app.post_track, "cues": app.post_cues,
                   "remove": app.post_remove, "node/create": app.post_node_create, "node/update": app.post_node_update,
                   "node/delete": app.post_node_delete, "node/tracks": app.post_node_tracks,
                   "settings": app.post_settings, "export": app.post_export,
                   "import/rekordbox": app.post_import_rekordbox, "import/stick": app.post_import_stick, "suggest": app.post_suggest, "licence/signin": app.post_licence_signin,
                   "licence/key": app.post_licence_key, "licence/signout": app.post_licence_signout, "licence/invite": app.post_licence_invite,
                   "licence/revoke": app.post_licence_revoke, "licence/token": app.post_licence_token, "getpro": app.post_get_pro, "report": app.post_report, "jserror": app.post_jserror, "set": app.post_set, "smart/preview": app.post_smart_preview,
                   "duplicates": app.post_duplicates, "relink": app.post_relink, "history": app.post_history, "stick/check": app.post_stick_check, "backup": app.post_backup,
                   "wish": app.post_wish, "open": app.post_open, "reveal": app.post_reveal, "update/fetch": app.post_update_fetch,
                   "engine/start": app.post_engine_start, "pcm": app.post_pcm, "update/check": app.post_update_check,
                   "slsk/search": app.post_slsk_search, "slsk/download": app.post_slsk_download,
                   "slsk/connect": app.post_slsk_connect, "slsk/batch": app.post_slsk_batch,
                   "slsk/batch/preview": app.post_slsk_batch_preview, "slsk/batch/stop": app.post_slsk_batch_stop}

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
