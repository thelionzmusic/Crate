"""Background work: scanning, analysis across every core, imports and exports."""
from __future__ import annotations

import os
import threading
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable

from . import audio
from .analysis import analyse_file
from .export import usb
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
        rows = self.lib.q("SELECT id, path FROM tracks" + ("" if ids is None else
                                                            f" WHERE id IN ({','.join(map(str, map(int, ids)))})"))
        s = self.lib.settings()
        args = (float(s["bpm_min"]), float(s["target_lufs"]), float(s["ceiling"]))
        t0, done, errors = time.perf_counter(), 0, 0
        pool = self.pool()
        futures = {pool.submit(analyse_file, r["path"], *args): r["id"] for r in rows}
        for fut in as_completed(futures):
            r = fut.result()
            self.lib.save_analysis(futures[fut], r)
            done += 1
            errors += not r["ok"]
            rate = done / max(1e-6, time.perf_counter() - t0)
            eta = (len(rows) - done) / rate if rate else 0
            self._report(f"{done} of {len(rows)} done, {rate:.1f} tracks a second, about {eta:.0f}s left", done / len(rows))
        return {"analysed": done, "errors": errors, "seconds": round(time.perf_counter() - t0, 1)}

    def export(self, root: str, node_ids: list[int] | None, everything: bool, opts: usb.Options) -> None:
        def run():
            tracks, nodes, cues, target, phrases = self.lib.export_payload(node_ids, everything)
            if not tracks:
                raise ValueError("Nothing to export: pick playlists with analysed tracks.")
            res = usb.export(Path(root), tracks, nodes, cues, self.lib.wave, opts, self._report, phrases)
            return {**res, "target_lufs": target if opts.level else None}
        self.submit("Exporting", run)

    def run(self, name: str, fn: Callable[[Callable[[str, float], None]], dict]) -> None:
        self.submit(name, lambda: fn(self._report))
