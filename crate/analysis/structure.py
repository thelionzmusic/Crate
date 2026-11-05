"""Phrase analysis and automatic cue points.

Dance music is built in 8/16/32-bar phrases. We measure per-bar energy in three bands
from the waveform, find where the music changes on the phrase grid, then label each
phrase by its energy and whether the kick is playing:

  Intro      opening phrases, before the first full-energy section
  Build      lifting section that leads straight into a drop
  Drop       full energy with the kick and bass in
  Breakdown  the kick drops out mid-track
  Verse      everything else in the body of the track
  Outro      closing phrases after the last full-energy section
"""
from __future__ import annotations

import numpy as np

from .waveform import FPS

LABELS = ("Intro", "Verse", "Build", "Drop", "Breakdown", "Outro")
# Hot cue colours per phrase kind (also used by the UI)
COLOURS = {"Intro": "#4ade80", "Verse": "#2dd4bf", "Build": "#facc15", "Drop": "#ef4444",
           "Breakdown": "#3b82f6", "Outro": "#a855f7"}
PHRASE = 8  # bars


def bars(bpm: float, first_beat_ms: float, downbeat: int, duration_s: float) -> np.ndarray:
    """Start times (s) of every bar, from the first downbeat."""
    if bpm <= 0:
        return np.zeros(0)
    beat = 60.0 / bpm
    first = first_beat_ms / 1000.0 + (downbeat % 4) * beat  # grid beat `downbeat` is beat 1 of the bar
    while first - 4 * beat >= 0:
        first -= 4 * beat
    return np.arange(first, duration_s - 4 * beat + 1e-6, 4 * beat)


def _bar_features(wave: np.ndarray, starts: np.ndarray, bar_s: float) -> np.ndarray:
    w = wave.astype(np.float32) / 255.0
    idx = (starts * FPS).astype(int)
    end = np.minimum(idx + int(bar_s * FPS), len(w))
    feats = np.zeros((len(starts), 3), np.float32)
    for i, (a, b) in enumerate(zip(idx, end)):
        if b > a:
            feats[i] = np.sqrt(np.mean(w[a:b] ** 2, axis=0))  # RMS per band
    return feats


def refine_downbeat(wave: np.ndarray, bpm: float, first_beat_ms: float, downbeat: int) -> int:
    """Pick the downbeat that puts the track's biggest changes on bar starts.

    Sections change on the one, so this is a stronger cue than kick accents, which are often
    identical on every beat. Falls back to the given downbeat when there's no clear winner."""
    if bpm <= 0 or len(wave) < FPS * 30:
        return downbeat
    beat = 60.0 / bpm
    t = first_beat_ms / 1000.0 + np.arange(int((len(wave) / FPS - first_beat_ms / 1000.0) / beat)) * beat
    f = _bar_features(wave, t, beat)  # per beat
    rel = f / (f.mean(axis=0) + 1e-6)     # relative level, so noise stays small
    n = len(rel)
    if n < 64:
        return downbeat
    nov = np.zeros(n)
    for i in range(8, n - 8):
        nov[i] = np.linalg.norm(rel[i:i + 8].mean(axis=0) - rel[i - 8:i].mean(axis=0))
    # genuine section changes only: local maxima (one per change) that are clearly large
    peaks = [i for i in range(8, n - 8) if nov[i] >= 0.35 and nov[i] == nov[max(0, i - 4):i + 5].max()]
    if len(peaks) < 2:
        return downbeat
    score = np.array([sum(nov[i] for i in peaks if (i - d) % 4 == 0) for d in range(4)])
    best = int(np.argmax(score))
    ranked = np.sort(score)
    return best if ranked[-1] > 1.3 * ranked[-2] else downbeat


def phrases(wave: np.ndarray, bpm: float, first_beat_ms: float, downbeat: int, duration_s: float) -> list[dict]:
    """[{start_bar, bars, start_ms, end_ms, label}] covering the track from the first downbeat."""
    starts = bars(bpm, first_beat_ms, downbeat, duration_s)
    n = len(starts)
    if n < PHRASE * 2 or len(wave) == 0:
        return []
    bar_s = 240.0 / bpm
    f = _bar_features(wave, starts, bar_s)
    z = (f - f.mean(axis=0)) / (f.std(axis=0) + 1e-6)

    # Novelty at each bar boundary: how different the 4 bars after are from the 4 before.
    nov = np.zeros(n)
    for b in range(4, n - 3):
        nov[b] = np.linalg.norm(z[b:b + 4].mean(axis=0) - z[b - 4:b].mean(axis=0))

    # Phrase grid alignment: the 8-bar offset where changes line up best.
    offset = int(np.argmax([nov[o::PHRASE].sum() for o in range(PHRASE)]))
    grid = [b for b in range(offset, n, PHRASE) if 0 < b < n]
    if nov.max() <= 0:
        cuts = []
    else:
        thr = max(0.6, float(np.mean(nov[grid]) + 0.25 * np.std(nov[grid]))) if grid else np.inf
        cuts = [b for b in grid if nov[b] >= thr]
    edges = sorted({0, *cuts, n})
    # Second pass: the bassline arriving or leaving is the defining change in dance music
    # even when overall energy barely moves, so split wherever the low band steps on the grid.
    low_bar = f[:, 0]
    for g in grid:
        if g in edges or g < 4 or g > n - 4:
            continue
        before, after = low_bar[max(0, g - 8):g].mean(), low_bar[g:g + 8].mean()
        if max(before, after) > 0 and max(before, after) / (min(before, after) + 1e-3) >= 1.25:
            edges.append(g)
    edges = sorted(set(edges))

    energy = f.mean(axis=1)
    low = f[:, 0]
    e_hi, e_lo = np.percentile(energy, 90), np.percentile(energy, 10)
    l_hi = np.percentile(low, 90)
    segs = []
    for a, b in zip(edges[:-1], edges[1:]):
        e = (energy[a:b].mean() - e_lo) / (e_hi - e_lo + 1e-6)
        k = low[a:b].mean() / (l_hi + 1e-6)
        slope = np.polyfit(np.arange(b - a), energy[a:b], 1)[0] / (e_hi - e_lo + 1e-6) if b - a > 2 else 0.0
        segs.append({"a": a, "b": b, "e": float(e), "k": float(k), "slope": float(slope)})

    peak = max(s["e"] for s in segs)
    for s in segs:
        if s["k"] < 0.45 and s["e"] < 0.6 * peak:
            s["label"] = "Breakdown"
        elif s["e"] >= 0.72 * peak and s["k"] >= 0.85:  # full bassline in, not just the kick
            s["label"] = "Drop"
        else:
            s["label"] = "Verse"
    drops = [i for i, s in enumerate(segs) if s["label"] == "Drop"]
    if drops:
        for i in range(drops[0]):  # before the first drop: intro (breakdowns there are still intro)
            if segs[i]["label"] != "Breakdown" or i == 0:
                segs[i]["label"] = "Intro"
        for i in range(drops[-1] + 1, len(segs)):
            segs[i]["label"] = "Outro"
        for i in range(1, len(segs)):  # a lifting phrase straight before a drop is a build
            if segs[i]["label"] == "Drop" and segs[i - 1]["label"] in ("Verse", "Intro", "Breakdown") \
                    and segs[i - 1]["slope"] > 0.01 and i - 1 > 0:
                segs[i - 1]["label"] = "Build"
    else:
        segs[0]["label"] = "Intro"
        if len(segs) > 1:
            segs[-1]["label"] = "Outro"

    # Merge neighbours that ended up with the same label.
    merged = []
    for s in segs:
        if merged and merged[-1]["label"] == s["label"]:
            merged[-1]["b"] = s["b"]
        else:
            merged.append(dict(s))
    end_s = lambda b: starts[b] if b < n else min(duration_s, starts[-1] + bar_s)  # noqa: E731
    return [{"start_bar": s["a"], "bars": s["b"] - s["a"], "label": s["label"],
             "start_ms": int(round(starts[s["a"]] * 1000)), "end_ms": int(round(end_s(s["b"]) * 1000))}
            for s in merged]


def auto_cues(phr: list[dict]) -> list[dict]:
    """Hot cues on the moments DJs reach for, memory cues on every phrase.

    A = mix-in point (first downbeat). Then, in track order and up to H: each drop, each
    breakdown, each build, and the outro."""
    if not phr:
        return []
    cues = [{"slot": 0, "start_ms": p["start_ms"], "end_ms": -1, "color": None, "name": p["label"]} for p in phr]
    wanted = [phr[0]] + [p for p in phr[1:] if p["label"] in ("Drop", "Breakdown", "Build", "Outro")]
    for slot, p in enumerate(wanted[:8], 1):
        name = "Start" if slot == 1 else p["label"]
        cues.append({"slot": slot, "start_ms": p["start_ms"], "end_ms": -1, "color": COLOURS[p["label"]], "name": name})
    return cues
