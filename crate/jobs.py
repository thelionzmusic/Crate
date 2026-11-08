"""Background work: scanning, analysis across every core, imports and exports."""
from __future__ import annotations

import os
import threading
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable

from . import audio, fingerprint
from .analysis import analyse_file
from .export import pdb, pdbread, usb
from .library import Library


def workers() -> int:
    """All hardware threads but one, so the UI and USB writes stay responsive.
    (A 13900KF has 32: 16 hyper-threaded P-cores + 16 E-cores.)"""
    return max(1, (os.cpu_count() or 2) - 1)


class Jobs:
    def __init__(self, lib: Library):
        self.lib = lib
        self.state = {"name": "", "message": "", "progress": 0.0, "running": False, "result": None, "error": None}
        self._lock = threading.Lock()
        self._queue: list[tuple[str, Callable]] = []
        self._pool: ProcessPoolExecutor | None = None

    def pool(self) -> ProcessPoolExecutor:
        if self._pool is None:
            self._pool = ProcessPoolExecutor(max_workers=workers())
        return self._pool

    def snapshot(self) -> dict:
        with self._lock:
            return {**self.state, "queued": [n for n, _ in self._queue]}

    def _report(self, message: str, progress: float) -> None:
        with self._lock:
            self.state.update(message=message, progress=round(progress, 4))

    def submit(self, name: str, fn: Callable) -> None:
        with self._lock:
            self._queue.append((name, fn))
            if self.state["running"]:
                return
            self.state["running"] = True
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self) -> None:
        while True:
            with self._lock:
                if not self._queue:
                    self.state["running"] = False
                    return
                name, fn = self._queue.pop(0)
                self.state.update(name=name, message="", progress=0.0, result=None, error=None)
            try:
                result = fn()
                with self._lock:
                    self.state.update(result=result, progress=1.0)
            except Exception as e:
                traceback.print_exc()
                with self._lock:
                    self.state.update(error=f"{type(e).__name__}: {e}")

    # ---- jobs ------------------------------------------------------------------
    def scan(self, folders: list[str] | None = None) -> None:
        self.submit("Scanning", lambda: self._scan(folders))

    def _scan(self, folders: list[str] | None) -> dict:
        roots = folders or [r["path"] for r in self.lib.q("SELECT path FROM folders")]
        self._report("Finding audio files", 0.0)
        files = [str(p) for r in roots for p in Path(r).rglob("*")
                 if p.suffix.lower() in audio.AUDIO_EXT and p.is_file() and not p.name.startswith("._")]
        known = self.lib.known()
        todo = []
        for f in files:
            k = known.get(f)
            st = os.stat(f)
            if not k or k[1] != st.st_mtime or k[2] != st.st_size:
                todo.append(f)
        added, failed = [], 0
        with ThreadPoolExecutor(max_workers=16) as tp:  # ffprobe is process-bound, not CPU-bound
            futures = {tp.submit(audio.probe, f): f for f in todo}
            for i, fut in enumerate(as_completed(futures), 1):
                try:
                    added.append(self.lib.upsert(futures[fut], fut.result()))
                except Exception:
                    failed += 1
                if i % 20 == 0:
                    self._report(f"Reading tags, {i} of {len(todo)}", 0.2 * i / len(todo))
        pending = [r["id"] for r in self.lib.q("SELECT id FROM tracks WHERE analysed IS NULL")]
        if pending:
            self._analyse(pending)
        return {"found": len(files), "new_or_changed": len(added), "unreadable": failed, "analysed": len(pending)}

    def analyse(self, ids: list[int] | None = None) -> None:
        self.submit("Analysing", lambda: self._analyse(ids))

    def _analyse(self, ids: list[int] | None) -> dict:
        rows = self.lib.q("SELECT id, path, codec, bitrate, sample_rate FROM tracks" +
                          ("" if ids is None else f" WHERE id IN ({','.join(map(str, map(int, ids)))})"))
        if not rows:
            return {"analysed": 0, "errors": 0, "seconds": 0}
        s = self.lib.settings()
        args = (float(s["bpm_min"]), float(s["target_lufs"]), float(s["ceiling"]))
        t0, done, errors = time.perf_counter(), 0, 0
        pool = self.pool()
        futures = {pool.submit(analyse_file, r["path"], *args,
                               {"codec": r["codec"], "bitrate": r["bitrate"], "sample_rate": r["sample_rate"]}): r["id"]
                   for r in rows}
        for fut in as_completed(futures):
            r = fut.result()
            self.lib.save_analysis(futures[fut], r)
            done += 1
            errors += not r["ok"]
            rate = done / max(1e-6, time.perf_counter() - t0)
            eta = (len(rows) - done) / rate if rate else 0
            self._report(f"{done} of {len(rows)}, {rate:.1f} a second, about {eta:.0f}s left", done / len(rows))
        return {"analysed": done, "errors": errors, "seconds": round(time.perf_counter() - t0, 1)}

    def add_files(self, paths: list[str], name: str = "Importing downloads") -> None:
        """Probe, add and analyse specific files (new purchases from the downloads folder)."""
        def run():
            ids = []
            for p in paths:
                try:
                    ids.append(self.lib.upsert(p, audio.probe(p)))
                except Exception:
                    continue
            res = self._analyse(ids)
            return {**res, "added": len(ids), "ids": ids}
        self.submit(name, run)

    # ---- library care ------------------------------------------------------------
    def relink(self, folder: str) -> None:
        """Reconnect tracks whose files moved: same name and size first, then by sound."""
        def run():
            missing = [dict(r) for r in self.lib.q("SELECT id, path, size, duration FROM tracks") if not os.path.exists(r["path"])]
            if not missing:
                return {"missing": 0, "found": 0}
            self._report("Looking for audio files", 0.02)
            files = [p for p in Path(folder).rglob("*") if p.suffix.lower() in audio.AUDIO_EXT and p.is_file()]
            known = set(self.lib.known())
            files = [p for p in files if str(p) not in known]
            by_name: dict[tuple[str, int], Path] = {(p.name.lower(), p.stat().st_size): p for p in files}
            found, left = 0, []
            for t in missing:
                hit = by_name.get((Path(t["path"]).name.lower(), t["size"]))
                if hit:
                    self.lib.relink(t["id"], str(hit), {"size": hit.stat().st_size, "mtime": hit.stat().st_mtime})
                    files.remove(hit)
                    found += 1
                else:
                    left.append(t)
            if left and files:  # renamed or re-encoded: compare by sound, among files of similar length
                with ThreadPoolExecutor(max_workers=16) as tp:
                    probes = {p: info for p, info in zip(files, tp.map(lambda p: _try_probe(p), files)) if info}
                cands = [(p, info) for p, info in probes.items()
                         if any(abs(info["duration"] - (t["duration"] or 0)) < 4 for t in left)]
                pool, prints = self.pool(), {}
                for i, (p, w) in enumerate(zip([c[0] for c in cands], pool.map(_wave_of, [str(c[0]) for c in cands]))):
                    prints[p] = fingerprint.of(w)
                    self._report(f"Listening to candidates, {i + 1} of {len(cands)}", 0.1 + 0.8 * (i + 1) / max(1, len(cands)))
                for t in left:
                    mine = fingerprint.of(self.lib.wave(t["id"]))
                    best = max(((fingerprint.similarity(mine, fp), p) for p, fp in prints.items()
                                if abs(probes[p]["duration"] - (t["duration"] or 0)) < 4), default=(0, None))
                    if best[1] is not None and best[0] >= fingerprint.MATCH:
                        p = best[1]
                        self.lib.relink(t["id"], str(p), probes[p])
                        prints.pop(p)
                        found += 1
            return {"missing": len(missing), "found": found}
        self.submit("Finding moved files", run)

    def duplicates(self) -> None:
        def run():
            rows = self.lib.rows()
            for t in rows:
                t["issues"] = self.lib.issues(t)
            self._report("Comparing recordings", 0.3)
            return {"groups": fingerprint.duplicates(rows, self.lib.wave)}
        self.submit("Finding duplicates", run)

    def refresh_cues(self, ids: list[int] | None = None) -> None:
        """Bring smart cues up to the current layout. Tracks with cues you set yourself keep them."""
        todo = ids if ids is not None else self.lib.stale_cues()
        if not todo:
            return
        def run():
            for k, tid in enumerate(todo):
                self.lib.restructure(tid)
                if k % 25 == 0:
                    self._report("Updating smart cues", k / len(todo))
            return {"cues": len(todo)}
        self.submit("Updating smart cues", run)

    # ---- sticks ------------------------------------------------------------------
    def harvest_history(self, root: Path) -> dict:
        """Copy the stick's play history into the library before anything overwrites it."""
        sessions = pdbread.history(Path(root) / "PIONEER" / "rekordbox" / "export.pdb")
        known = {r["id"] for r in self.lib.q("SELECT id FROM tracks")}
        imported, plays = 0, {}
        if sessions:
            parent = self.lib.folder("History")
            existing = {n["name"] for n in self.lib.nodes() if n["parent_id"] == parent}
            for s in sessions:
                ids = [t for t in s["tracks"] if t in known]
                if not ids or s["name"] in existing:
                    continue  # already imported this session
                self.lib.set_node_tracks(self.lib.create_node(s["name"], parent), ids)
                for t in ids:
                    plays[t] = plays.get(t, 0) + 1
                imported += 1
            self.lib.bump_plays(plays)
        return {"sessions": imported, "plays": sum(plays.values())}

    def import_history(self, root: str) -> None:
        self.submit("Importing play history", lambda: self.harvest_history(Path(root)))

    def export(self, roots: list[str] | str, node_ids: list[int] | None, everything: bool, opts: usb.Options) -> None:
        roots = [roots] if isinstance(roots, str) else list(roots)

        def run():
            tracks, nodes, cues, target, phrases = self.lib.export_payload(node_ids, everything)
            if not tracks:
                raise ValueError("Nothing to export: pick playlists with analysed tracks.")
            results = []
            for k, root in enumerate(roots):
                hist = self.harvest_history(Path(root))
                scale = lambda msg, p, k=k: self._report(  # noqa: E731
                    f"{Path(root).anchor or root}  {msg}" if len(roots) > 1 else msg, (k + p) / len(roots))
                res = usb.export(Path(root), tracks, [pdb.Node(**vars(n)) for n in nodes], cues, self.lib.wave,
                                 opts, scale, phrases)
                results.append({**res, "root": root, "history": hist})
            first = results[0]
            return {**first, "sticks": results, "target_lufs": target if opts.level else None,
                    "warnings": [w for r in results for w in r["warnings"]]}
        self.submit("Exporting", run)

    def run(self, name: str, fn: Callable[[Callable[[str, float], None]], dict]) -> None:
        self.submit(name, lambda: fn(self._report))


def _try_probe(p: Path) -> dict | None:
    try:
        return audio.probe(p)
    except Exception:
        return None


def _wave_of(path: str):
    """Waveform only, for fingerprinting candidate files in the process pool."""
    from .analysis import waveform
    x = audio.decode(path)
    return waveform.compute(x.mean(axis=1), 44100)
