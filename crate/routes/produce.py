"""Production: the open set (tracks, clips, scenes, arrangement), saved as it changes, and
the sample folders the browser shows."""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path

from .. import desktop
from . import route

SAMPLE_TYPES = {".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg", ".m4a"}
TRACK_COLOURS = ["#9d7bff", "#4f8cff", "#2fc4b2", "#e8c547"]  # the first of the page's palette (produce/set.js)
SAMPLE_CACHE_KEEP = 400  # samples decoded for the native engine (most are a few seconds)
SCAN_CAP = 50_000  # a sample folder that big is listed in part rather than freezing the browser


def empty_set() -> dict:
    """A new set, as Ableton opens one: two MIDI tracks (each with Crate FM, so drawn notes are
    heard) and two audio tracks, nothing in them, and two returns already holding a reverb and a
    delay, fully wet, for the sends to feed."""
    synth = lambda dev: [{"id": dev, "type": "fm", "on": True, "params": {}}]  # noqa: E731
    track = lambda i, kind: {"id": i, "name": f"{i} {'MIDI' if kind == 'midi' else 'Audio'}", "kind": kind,  # noqa: E731
                             "colour": TRACK_COLOURS[i - 1], "volume": 0.85, "pan": 0.0, "mute": False, "solo": False,
                             "clips": {}, "sends": {}, "devices": synth(6 + i) if kind == "midi" else []}
    ret = lambda rid, name, colour, dev, kind: {"id": rid, "name": name, "colour": colour, "volume": 0.85, "pan": 0.0, "mute": False,  # noqa: E731
                                                "devices": [{"id": dev, "type": kind, "on": True, "params": {"mix": 1}}]}
    return {"version": 2, "bpm": 120.0, "follow": True, "scenes": 8, "next_id": 9,
            "tracks": [track(1, "midi"), track(2, "midi"), track(3, "audio"), track(4, "audio")],
            "returns": [ret("A", "A Reverb", "#b48cff", 5, "reverb"), ret("B", "B Delay", "#4cd18a", 6, "delay")],
            "arrangement": [], "main": {"volume": 0.85, "devices": []}}


class ProduceRoutes:
    _samples: tuple[float, dict] = (0.0, {})
    _set_lock = threading.Lock()

    def _project_file(self) -> Path:
        return self.home / "sets" / "current.json"

    @route("GET", "project")
    def get_project(self, _):
        try:
            return json.loads(self._project_file().read_text("utf-8"))
        except (OSError, ValueError):
            return empty_set()

    @route("POST", "project")
    def post_project(self, body):
        """Saved whole on every change (the page batches them); written beside, then swapped in,
        so a crash mid-write never leaves half a set."""
        if not isinstance(body, dict) or "tracks" not in body:
            raise ValueError("That isn't a set")
        f = self._project_file()
        f.parent.mkdir(exist_ok=True)
        with self._set_lock:
            tmp = f.with_suffix(".tmp")
            tmp.write_text(json.dumps(body, separators=(",", ":")), "utf-8")
            os.replace(tmp, f)
        return {}

    @route("POST", "project/new")
    def post_project_new(self, _):
        self.post_project(empty_set())
        return empty_set()

    # ---- samples ------------------------------------------------------------------
    def _sample_folders(self) -> list[str]:
        try:
            return [f for f in json.loads(self.lib.settings().get("sample_folders") or "[]") if Path(f).is_dir()]
        except ValueError:
            return []

    @route("GET", "samples")
    def get_samples(self, _):
        """Every sample in the folders you've added, as [folder index, path inside it]: one walk,
        reused for half a minute, so searching and browsing never touch the disk."""
        at, cached = self._samples
        if time.monotonic() - at < 30 and cached.get("folders") == self._sample_folders():
            return cached
        folders, files = self._sample_folders(), []
        for k, root in enumerate(folders):
            for dirpath, dirs, names in os.walk(root):
                dirs.sort()
                rel = os.path.relpath(dirpath, root).replace("\\", "/")
                files += [[k, n if rel == "." else f"{rel}/{n}"] for n in sorted(names) if Path(n).suffix.lower() in SAMPLE_TYPES]
                if len(files) >= SCAN_CAP:
                    break
        out = {"folders": folders, "files": files[:SCAN_CAP], "capped": len(files) >= SCAN_CAP}
        ProduceRoutes._samples = (time.monotonic(), out)
        return out

    @route("POST", "samples/folder")
    def post_sample_folder(self, body):
        folders = self._sample_folders()
        if body.get("remove"):
            folders = [f for f in folders if f != body["remove"]]
        else:
            path = body.get("path") or desktop.pick("folder")
            if not path:
                return {"folders": folders}
            if not Path(path).is_dir():
                raise ValueError("That folder isn't there")
            folders = [*folders, path] if path not in folders else folders
        self.lib.set("sample_folders", json.dumps(folders))
        ProduceRoutes._samples = (0.0, {})
        return self.get_samples(None)

    def _sample(self, k, rel) -> Path:
        """A sample's file, only from inside a folder you added."""
        try:
            root = Path(self._sample_folders()[int(k)]).resolve()
        except (IndexError, ValueError):
            raise ValueError("No such sample") from None
        f = (root / rel).resolve()
        if root not in f.parents or not f.is_file() or f.suffix.lower() not in SAMPLE_TYPES:
            raise ValueError("No such sample")
        return f

    @route("GET", "sample")
    def get_sample(self, q):
        """One sample's audio, for the browser's own playback."""
        try:
            return self._sample(q["f"][0], q["p"][0])
        except KeyError:
            raise ValueError("No such sample") from None

    @route("POST", "sample/pcm")
    def post_sample_pcm(self, body):
        """A sample decoded for the native engine, kept apart from the decks' decoded tracks."""
        f = self._sample(body["f"], body["p"])
        key = hashlib.sha1(str(f).encode("utf-8")).hexdigest()[:16]
        return self.engine.decode(str(f), key, int(body["rate"]), folder="pcm/samples", keep=SAMPLE_CACHE_KEEP)
