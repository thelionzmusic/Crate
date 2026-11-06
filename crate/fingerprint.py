"""Audio fingerprints for spotting the same recording twice, whatever the file.

A fingerprint is the track's energy in three bands, 15 values a second, taken from the
waveform Crate already stores. That's fine enough to capture the actual drums and bass,
not just the arrangement, so two tracks built the same way still differ. Two files of one
recording (MP3 vs WAV, different tags, a trimmed silence) line up almost perfectly.
"""
from __future__ import annotations

import numpy as np

from .analysis.waveform import FPS

RATE = 15  # fingerprint frames per second
MATCH = 0.95


def of(wave: np.ndarray) -> np.ndarray:
    """(n, 3) log-energy contour, normalised per band."""
    step = FPS // RATE
    n = len(wave) // step
    if n < RATE * 20:
        return np.zeros((0, 3), np.float32)
    w = wave[: n * step].astype(np.float32).reshape(n, step, 3).mean(axis=1)
    f = np.log1p(w)
    return (f - f.mean(axis=0)) / (f.std(axis=0) + 1e-6)


def similarity(a: np.ndarray, b: np.ndarray, max_shift_s: float = 4.0) -> float:
    """Best correlation over small offsets (leading silence, different edits of the start)."""
    if not len(a) or not len(b):
        return 0.0
    best = -1.0
    for shift in range(-int(max_shift_s * RATE), int(max_shift_s * RATE) + 1):
        x, y = (a[shift:], b) if shift >= 0 else (a, b[-shift:])
        n = min(len(x), len(y))
        if n < RATE * 20:
            continue
        c = float(np.mean(x[:n] * y[:n]))
        best = max(best, c)
    return best


def _quality_rank(t: dict) -> tuple:
    lossless = t.get("codec") in ("pcm", "flac", "alac", "aiff")
    issues = len(t.get("issues") or [])
    return (issues == 0, lossless, t.get("bitrate") or 0, t.get("bit_depth") or 0, -(t["id"]))


def duplicates(tracks: list[dict], wave_of) -> list[dict]:
    """Groups of tracks that are the same recording, best copy first.

    Only compares tracks of similar length, so it stays quick on large libraries."""
    tracks = [t for t in tracks if t.get("duration")]
    tracks.sort(key=lambda t: t["duration"])
    prints: dict[int, np.ndarray] = {}
    fp = lambda tid: prints.setdefault(tid, of(wave_of(tid)))  # noqa: E731
    parent = {t["id"]: t["id"] for t in tracks}

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(tracks):
        for b in tracks[i + 1:]:
            if b["duration"] - a["duration"] > 6:
                break
            if root(a["id"]) == root(b["id"]):
                continue
            if a.get("bpm") and b.get("bpm") and abs(a["bpm"] - b["bpm"]) > 0.6:
                continue  # one recording has one tempo
            if similarity(fp(a["id"]), fp(b["id"])) >= MATCH:
                parent[root(b["id"])] = root(a["id"])
    groups: dict[int, list[dict]] = {}
    for t in tracks:
        groups.setdefault(root(t["id"]), []).append(t)
    out = []
    for members in groups.values():
        if len(members) > 1:
            members.sort(key=_quality_rank, reverse=True)
            out.append({"keep": members[0]["id"], "tracks": [m["id"] for m in members]})
    return out
