"""Soulseek through slskd (Labs): search, downloads, CSV batches, and filing finished tracks."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from .. import soulseek
from . import route


class DownloadsRoutes:
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

    @route("GET", "slsk")
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

    @route("POST", "slsk/connect")
    def post_slsk_connect(self, body):
        """Save the Soulseek login (built-in mode) and (re)start slskd with it."""
        for k in ("slsk_user", "slsk_pass"):
            if body.get(k):
                self.lib.set(k, body[k].strip())
        self._slsk_up()
        return {}

    @route("POST", "slsk/search")
    def post_slsk_search(self, body):
        return {"id": self._slsk().search(body["q"].strip())}

    @route("GET", "slsk-results")
    def get_slsk_results(self, sid):
        return self._slsk().results(sid)

    @route("POST", "slsk/download")
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
            self.jobs.submit("Adding to playlist", dict)  # the page reloads playlists when a job ends
        return transfers

    @route("GET", "slsk-downloads")
    def get_slsk_downloads(self, _):
        return self._slsk_sync(max_age=1.5)

    # batches: a CSV of tracks, found and downloaded one after another in the background
    @route("POST", "slsk/batch")
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

    @route("POST", "slsk/batch/preview")
    def post_slsk_batch_preview(self, body):
        items = soulseek.parse_csv(body["csv"])
        return {"count": len(items), "sample": items[:8]}

    @route("POST", "slsk/batch/stop")
    def post_slsk_batch_stop(self, _):
        if self.slsk_batch:
            self.slsk_batch.cancelled = True
        return {}

    @route("GET", "slsk-batch")
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
