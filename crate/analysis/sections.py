"""Song structure and the cue points placed from it.

Dance music is built in 8-bar phrases. Per-bar energy in three bands, from the waveform,
shows where the music changes on the phrase grid; each section is then labelled by its
energy and whether the bassline is in:

  Intro      opening phrases, before the first full-energy section
  Build      a lifting section that leads straight into a drop
  Drop       full energy with the kick and bass in
  Breakdown  the kick drops out mid-track
  Verse      everything else in the body of the track
  Outro      closing phrases after the last full-energy section

This reads the beat grid and never changes it: bar 1 is the tempo analysis's alone.
"""
from __future__ import annotations

import numpy as np

from .waveform import FPS

COLOURS = {"Intro": "#4ade80", "Verse": "#2dd4bf", "Build": "#facc15", "Drop": "#ef4444",
           "Breakdown": "#3b82f6", "Outro": "#a855f7"}  # Pioneer's hot cue colours by section
PHRASE = 8  # bars
HOT_CUES = 8


def _bar_features(wave: np.ndarray, starts: np.ndarray, bar_s) -> np.ndarray:
    """RMS per band over each span; bar_s is one length for all, or one per start."""
    w = wave.astype(np.float32) / 255.0
    idx = (starts * FPS).astype(int)
    end = np.minimum(idx + (np.asarray(bar_s) * FPS).astype(int), len(w))
    feats = np.zeros((len(starts), 3), np.float32)
    for i, (a, b) in enumerate(zip(idx, end)):
        if b > a:
            feats[i] = np.sqrt(np.mean(w[a:b] ** 2, axis=0))  # RMS per band
    return feats


def bar_starts(grid: list[tuple[int, float]]) -> np.ndarray:
    """Bar start times (s) from a beat grid of (beat in bar, ms): works for any tempo map."""
    return np.array([ms / 1000.0 for pos, ms in grid if pos == 1])


def phrases(wave: np.ndarray, starts: np.ndarray, duration_s: float) -> list[dict]:
    """[{start_bar, bars, start_ms, end_ms, label}] covering the track from the first downbeat.
    `starts` are the bar lines (bar_starts or bars), so tempo changes are followed."""
    n = len(starts)
    if n < PHRASE * 2 or len(wave) == 0:
        return []
    lengths = np.diff(starts, append=starts[-1] + (starts[-1] - starts[-2]))
    bar_s = float(lengths[-1])
    f = _bar_features(wave, starts, lengths)
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
        segs = _builds(segs, energy, f[:, 2], e_hi - e_lo)
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


def _builds(segs: list[dict], energy: np.ndarray, high: np.ndarray, span: float) -> list[dict]:
    """The build into each drop: the phrase just before it, when it rises (energy climbing, or
    the top end lifting as risers and snare rolls come in). A long breakdown that ends in a
    rise is split, its last phrase becoming the build."""
    out: list[dict] = []
    for i, s in enumerate(segs):
        nxt = segs[i + 1] if i + 1 < len(segs) else None
        if nxt and nxt["label"] == "Drop" and s["label"] in ("Verse", "Intro", "Breakdown") and i > 0:
            a = max(s["a"], s["b"] - PHRASE)
            tail = energy[a:s["b"]]
            slope = np.polyfit(np.arange(len(tail)), tail, 1)[0] / (span + 1e-6) if len(tail) > 2 else 0.0
            lift = high[a:s["b"]].mean() > 1.15 * (high[s["a"]:a].mean() if a > s["a"] else high[: s["a"]].mean() + 1e-6)
            if slope > 0.01 or lift:
                if a > s["a"]:
                    out.append({**s, "b": a})
                out.append({**s, "a": a, "label": "Build"})
                continue
        out.append(s)
    return out


def sections(phr: list[dict]) -> list[dict]:
    """Back-to-back phrases with the same label merged: the drop, not its 8-bar pieces."""
    out: list[dict] = []
    for p in phr:
        if out and out[-1]["label"] == p["label"]:
            out[-1] = {**out[-1], "end_ms": p["end_ms"], "bars": out[-1]["bars"] + p["bars"]}
        else:
            out.append(dict(p))
    return out


def cue_points(phr: list[dict]) -> list[dict]:
    """Hot cues A-H at each section in the order they come (Intro, Build, Drop, Breakdown,
    Build, Drop...), so every pad is the next part of the track; memory cues on every section.
    Verses don't take a pad unless there's room. The outro gets the last pad when there's one."""
    secs = sections(phr)
    if not secs:
        return []
    pads = [s for s in secs if s["label"] != "Verse"]
    verses = [s for s in secs if s["label"] == "Verse"][:max(0, HOT_CUES - len(pads))]
    pads = sorted(pads + verses, key=lambda s: s["start_ms"])  # spare pads go to verses, still in order
    outro = next((s for s in pads if s["label"] == "Outro"), None)
    pads = pads[:HOT_CUES]
    if outro and outro not in pads:
        pads[-1] = outro  # the way out matters more than a fourth drop
    count: dict[str, int] = {}
    cues = []
    for slot, s in enumerate(pads, 1):
        count[s["label"]] = count.get(s["label"], 0) + 1
        n = count[s["label"]]
        cues.append({"slot": slot, "start_ms": s["start_ms"], "end_ms": -1, "color": COLOURS[s["label"]],
                     "name": s["label"] if n == 1 else f"{s['label']} {n}"})
    cues += [{"slot": 0, "start_ms": s["start_ms"], "end_ms": -1, "color": None, "name": s["label"]} for s in secs]
    return cues
