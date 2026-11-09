"""Tempo, beat phase and downbeat, and the beat grid built from them.

Pipeline: log-spectral-flux onset envelope -> autocorrelation with bar-level harmonics
for the coarse tempo -> phase-folding sharpness for a 0.01 BPM refinement -> folded
kick-band envelope for the downbeat.

Three kinds of track come out of analyse():
  steady     one tempo; the grid is first beat + bpm (most dance music)
  sections   the tempo changes at points in the track (128 -> 140): an exact grid per
             section, switching on a bar line, with the bars counted straight through
  drifting   played live, the tempo wanders: a beat tracker follows it beat by beat
"""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

GRID_VERSION = 2  # 2: tempo sections. Older libraries are re-checked once in the background.
N_FFT, HOP = 512, 64
LOW_HZ = 150.0
# The flux peak lands this far before the attack's true onset (window ramp-up);
# measured on synthetic kicks in tests/test_analysis.py.
LATENCY_S = -0.0165


def onset_envelopes(x: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """Onset strength (full band, kick band) and linear bass energy, plus frames per second."""
    if len(x) < N_FFT * 2:
        return np.zeros(1), np.zeros(1), np.zeros(1), sr / HOP
    win = np.hanning(N_FFT).astype(np.float32)
    frames = sliding_window_view(x, N_FFT)[::HOP]
    low_bin = int(LOW_HZ * N_FFT / sr) + 1
    full, low, bass, prev = [], [], [], None
    for s in range(0, len(frames), 2048):
        lin = np.abs(np.fft.rfft(frames[s:s + 2048] * win, axis=1))
        bass.append(np.square(lin[:, :low_bin]).sum(axis=1))
        mag = np.log1p(100.0 * lin)
        stack = mag if prev is None else np.vstack([prev, mag])
        d = np.maximum(np.diff(stack, axis=0), 0.0)
        if prev is None:
            d = np.vstack([np.zeros((1, d.shape[1]), d.dtype), d])
        full.append(d.sum(axis=1))
        low.append(d[:, :low_bin].sum(axis=1))
        prev = mag[-1:]
    fps = sr / HOP
    return (_clean(np.concatenate(full), fps), _clean(np.concatenate(low), fps),
            np.concatenate(bass).astype(np.float64), fps)


def _clean(o: np.ndarray, fps: float) -> np.ndarray:
    k = max(3, int(fps * 0.5))
    o = np.maximum(o - np.convolve(o, np.ones(k) / k, mode="same"), 0.0)
    m = o.max()
    return (o / m).astype(np.float64) if m > 0 else o.astype(np.float64)


def _fold(o: np.ndarray, period: float, bins: int) -> np.ndarray:
    phase = (np.arange(len(o)) / period) % 1.0
    return np.bincount((phase * bins).astype(np.int64), weights=o, minlength=bins)[:bins]


def _sharpness(o: np.ndarray, period: float, bins: int = 48) -> float:
    h = _fold(o, period, bins)
    h = h + np.roll(h, 1) + np.roll(h, -1)  # circular smoothing, tolerant of jitter
    return float(h.max() / (h.mean() + 1e-12))


def estimate_bpm(o: np.ndarray, fps: float, bpm_min: float) -> float:
    """Coarse ACF tempo folded into [bpm_min, 2*bpm_min), then refined to 0.01 BPM."""
    n = len(o)
    f = np.fft.rfft(o - o.mean(), 2 * n)
    acf = np.fft.irfft(f * np.conj(f))[:n]
    acf /= acf[0] + 1e-12
    cands = np.arange(60.0, 200.0, 0.25)
    lag = 60.0 * fps / cands
    idx = np.arange(n)

    def at(lags):
        return np.interp(lags, idx, acf, right=0.0)

    score = at(lag) + 0.5 * at(2 * lag) + 0.25 * at(4 * lag)
    bpm = float(cands[int(np.argmax(score))])
    while bpm < bpm_min:
        bpm *= 2
    while bpm >= 2 * bpm_min:
        bpm /= 2

    def best(lo, hi, step):
        grid = np.arange(lo, hi, step)
        s = [_sharpness(o, 60.0 * fps / b) for b in grid]
        i = int(np.argmax(s))
        return float(grid[i]), s[i]

    bpm, _ = best(bpm * 0.97, bpm * 1.03, 0.05)
    bpm, s_best = best(bpm - 0.1, bpm + 0.1, 0.01)
    # Produced music is almost always on an integer (or half) BPM: snap if it costs nothing.
    for snap in (round(bpm), round(bpm * 2) / 2):
        if abs(snap - bpm) <= 0.05 and _sharpness(o, 60.0 * fps / snap) >= 0.95 * s_best:
            return float(snap)
    return round(bpm, 2)


def beat_phase(o: np.ndarray, low: np.ndarray, fps: float, bpm: float) -> float:
    """Time (s) of the first beat at or after 0, from the folded onset histogram."""
    period = 60.0 * fps / bpm
    bins = 256
    # Kicks sit on the beat; hats and claps often sit between. Lean on the kick band.
    h = _fold(o + 3.0 * low, period, bins)
    h = np.convolve(np.r_[h[-3:], h, h[:3]], np.hanning(7), mode="same")[3:-3]
    i = int(np.argmax(h))
    y0, y1, y2 = h[i - 1], h[i], h[(i + 1) % bins]
    denom = y0 - 2 * y1 + y2
    frac = 0.5 * (y0 - y2) / denom if denom else 0.0
    phase = ((i + frac) / bins) % 1.0
    t = (phase * period) / fps + (N_FFT / 2) / (fps * HOP) - LATENCY_S
    return t % (60.0 / bpm)


def downbeat(bass: np.ndarray, fps: float, bpm: float, first_beat: float) -> int:
    """Which of the first four beats is beat 1: the bar position carrying the most bass
    energy (kick accents, bass notes and phrase changes all land on the one)."""
    period = 60.0 * fps / bpm
    start = (first_beat + LATENCY_S) * fps - (N_FFT / 2) / HOP
    count = int((len(bass) - start - period) / period)
    if count < 8:
        return 0
    span = max(2, int(period * 0.4))
    cs = np.concatenate(([0.0], np.cumsum(bass)))
    beg = np.clip(np.round(start + period * np.arange(count)).astype(np.int64), 0, len(bass) - span)
    energy = np.sqrt(cs[beg + span] - cs[beg])
    score = [energy[k::4].mean() for k in range(4)]
    return int(np.argmax(score))


def analyse(x: np.ndarray, sr: int, bpm_min: float = 88.0) -> dict:
    """bpm, first_beat_ms and downbeat, plus for non-steady tracks beats_ms (every beat) and,
    when the tempo changes in sections, tempos: [{ms, bpm}] where each section starts."""
    o, low, bass, fps = onset_envelopes(x, sr)
    if len(o) < fps * 8 or o.max() == 0:
        return {"bpm": 0.0, "first_beat_ms": 0.0, "downbeat": 0, "beats_ms": None, "tempos": None}
    bpm = estimate_bpm(o, fps, bpm_min)
    t0 = beat_phase(o, low, fps, bpm)
    db = downbeat(bass, fps, bpm, t0)
    out = {"bpm": bpm, "first_beat_ms": round(t0 * 1000.0, 2), "downbeat": db, "beats_ms": None, "tempos": None}
    multi = sections(o, low, bass, fps, bpm_min, bpm, t0)
    if multi:
        out.update(multi)
    elif len(o) >= fps * 60 and drift(o, fps, bpm) >= 0.003:
        out["beats_ms"] = _tracked(o, low, fps, bpm)
    return out


def grid(bpm: float, first_beat_ms: float, downbeat: int, duration_s: float) -> list[tuple[int, float]]:
    """Beat list as (beat_in_bar 1-4, time_ms) covering the whole track."""
    if bpm <= 0:
        return []
    step = 60000.0 / bpm
    n = int((duration_s * 1000.0 - first_beat_ms) / step) + 1
    return [(((i - downbeat) % 4) + 1, first_beat_ms + i * step) for i in range(max(n, 0))]


def drift(o: np.ndarray, fps: float, bpm: float) -> float:
    """Largest relative tempo difference between quarters of the track (0.004 = 0.4%)."""
    q = len(o) // 4
    if q < fps * 20:
        return 0.0
    local = []
    for k in range(4):
        seg = o[k * q:(k + 1) * q]
        grid = np.arange(bpm * 0.97, bpm * 1.03, bpm * 0.0005)
        local.append(grid[int(np.argmax([_sharpness(seg, 60.0 * fps / b) for b in grid]))])
    return float((max(local) - min(local)) / bpm)


def track_beats(o: np.ndarray, fps: float, bpm: float, tightness: float = 400.0) -> np.ndarray:
    """Dynamic-programming beat tracker (Ellis 2007): beat frames that follow a drifting tempo."""
    period = 60.0 * fps / bpm
    lo, hi = int(period * 0.9), int(np.ceil(period * 1.1))
    offs = np.arange(lo, hi + 1)
    pen = -tightness * np.log(offs / period) ** 2
    n = len(o)
    score, back = o.astype(np.float64).copy(), np.full(n, -1)
    for i in range(hi, n):
        cand = score[i - offs] + pen
        j = int(np.argmax(cand))
        if cand[j] > 0:
            score[i] += cand[j]
            back[i] = i - offs[j]
    i = n - hi + int(np.argmax(score[n - hi:]))
    path = []
    while i >= 0:
        path.append(i)
        i = back[i]
    return np.array(path[::-1], dtype=np.float64)


def _tracked(o: np.ndarray, low: np.ndarray, fps: float, bpm: float) -> list[float] | None:
    """Beat times (ms) following a drifting tempo, for live-played tracks."""
    frames = track_beats(o + 2.0 * low, fps, bpm)
    if len(frames) < 32:
        return None
    t = (frames / fps + (N_FFT / 2) / (fps * HOP) - LATENCY_S) * 1000.0
    return [round(v, 2) for v in t if v >= 0]


# ---------- tracks whose tempo changes in sections
WIN_S, HOP_S = 16.0, 4.0       # local tempo windows
SAME = 0.008                   # tempos within 0.8% are the same section
MIN_SECTION_S = 24.0           # a tempo has to hold this long to count
STEADY = 0.004                 # ...and stay within 0.4% inside the section


def _to_s(frame: float, fps: float) -> float:
    return frame / fps + (N_FFT / 2) / (fps * HOP) - LATENCY_S


def _local_tempo(o: np.ndarray, fps: float, bpm_min: float) -> tuple[float, float]:
    """(bpm, confidence) for one window: coarse autocorrelation, then a 0.05 BPM refinement."""
    n = len(o)
    f = np.fft.rfft(o - o.mean(), 2 * n)
    acf = np.fft.irfft(f * np.conj(f))[:n]
    acf /= acf[0] + 1e-12
    cands = np.arange(60.0, 200.0, 0.5)
    lag = 60.0 * fps / cands
    at = lambda lags: np.interp(lags, np.arange(n), acf, right=0.0)  # noqa: E731
    bpm = float(cands[int(np.argmax(at(lag) + 0.5 * at(2 * lag) + 0.25 * at(4 * lag)))])
    while bpm < bpm_min:
        bpm *= 2
    while bpm >= 2 * bpm_min:
        bpm /= 2
    coarse = np.arange(bpm * 0.985, bpm * 1.015, 0.25)
    bpm = float(coarse[int(np.argmax(_sharpness_many(o, 60.0 * fps / coarse)))])
    fine = np.arange(bpm - 0.2, bpm + 0.21, 0.05)
    sharp = _sharpness_many(o, 60.0 * fps / fine)
    i = int(np.argmax(sharp))
    return float(fine[i]), float(sharp[i])


def _sharpness_many(o: np.ndarray, periods: np.ndarray, bins: int = 48) -> np.ndarray:
    """_sharpness for many periods at once: one bincount over every (period, phase bin)."""
    phase = (np.arange(len(o))[None, :] / periods[:, None]) % 1.0
    idx = (np.arange(len(periods))[:, None] * bins + (phase * bins).astype(np.int64)).ravel()
    h = np.bincount(idx, weights=np.broadcast_to(o, phase.shape).ravel(), minlength=len(periods) * bins).reshape(len(periods), bins)
    h = h + np.roll(h, 1, axis=1) + np.roll(h, -1, axis=1)
    return h.max(axis=1) / (h.mean(axis=1) + 1e-12)


def _hits(o: np.ndarray, frames: np.ndarray, base: np.ndarray) -> np.ndarray:
    """Onset strength at each beat (best of the frames either side) above the local level
    `base`, so beats in a silent breakdown count as nothing rather than as misses."""
    f = np.clip(np.round(frames).astype(np.int64), 1, len(o) - 2)
    return np.maximum(np.maximum(o[f - 1], o[f]), o[f + 1]) - base[f]


def sections(o: np.ndarray, low: np.ndarray, bass: np.ndarray, fps: float, bpm_min: float,
             bpm: float, t0: float) -> dict | None:
    """Beat grid for a track whose tempo changes, or None if it holds one tempo.

    1. Local tempo every 4 s over 16 s windows; windows without a clear pulse are ignored.
    2. Runs of the same tempo that hold for 24 s or more are sections.
    3. Each section gets its own exact tempo and phase, measured on that section alone.
    4. The switch goes on the bar line of the outgoing grid where the onsets fit both
       grids best, so bars count straight through the change.
    5. The result has to fit the beats clearly better than one tempo does, or it's dropped.
    """
    w, hop = int(WIN_S * fps), int(HOP_S * fps)
    if len(o) < w * 3:
        return None
    wins = []
    for a in range(0, len(o) - w + 1, hop):
        b, c = _local_tempo(o[a:a + w], fps, bpm_min)
        wins.append((a, a + w, b, c))
    conf = np.array([c for *_, c in wins])
    sure = conf >= 0.6 * np.median(conf)

    runs: list[list] = []  # [start_frame, end_frame, [tempos]]
    for (a, e, b, _), ok in zip(wins, sure):
        if not ok:
            continue
        if runs and abs(b / np.median(runs[-1][2]) - 1) <= SAME:
            runs[-1][1] = e
            runs[-1][2].append(b)
        else:
            runs.append([a, e, [b]])
    runs = [r for r in runs if (r[1] - r[0]) / fps >= MIN_SECTION_S]
    merged: list[list] = []  # neighbours at the same tempo (a breakdown between them) are one section
    for r in runs:
        if merged and abs(np.median(r[2]) / np.median(merged[-1][2]) - 1) <= SAME * 1.5:
            merged[-1][1] = r[1]
            merged[-1][2] += r[2]
        else:
            merged.append(r)
    if len(merged) < 2:
        return None
    # a real section holds its tempo; one that creeps is a live ramp, which the beat tracker follows
    if any((max(r[2]) - min(r[2])) / np.median(r[2]) > STEADY for r in merged):
        return None

    # each section's exact tempo and phase, from its own audio
    secs = []
    for a, e, _ in merged:
        sb = estimate_bpm(o[a:e], fps, bpm_min)
        ph = a / fps + beat_phase(o[a:e], low[a:e], fps, sb)
        secs.append({"a": a, "e": e, "bpm": sb, "phase": ph})
    if all(abs(s["bpm"] / secs[0]["bpm"] - 1) <= SAME * 1.5 for s in secs):
        return None

    dur = _to_s(len(o), fps)
    k = max(3, int(fps))
    base = np.convolve(o, np.ones(k) / k, mode="same")  # the level around each moment, over a second
    period0 = 60.0 / secs[0]["bpm"]
    first = secs[0]["phase"] % period0
    db = downbeat(bass[: secs[1]["a"]], fps, secs[0]["bpm"], first)
    times: list[float] = list(first + period0 * np.arange(int((dur - first) / period0) + 1))
    starts = [(0, secs[0]["bpm"])]  # (beat index, bpm) where each section begins
    to_frame = lambda t: (t - (N_FFT / 2) / (fps * HOP) + LATENCY_S) * fps  # noqa: E731
    for k in range(len(secs) - 1):
        cur, nxt = secs[k], secs[k + 1]
        i0 = starts[-1][0]
        pn = 60.0 / nxt["bpm"]
        # the change lies somewhere across the last window of this section and the first of the next
        lo_t, hi_t = _to_s(cur["e"] - w, fps), _to_s(nxt["a"] + w, fps)
        cands = [i for i in range(i0, len(times)) if (i - db) % 4 == 0 and lo_t <= times[i] <= hi_t]
        if not cands:  # the gap is shorter than a bar: take the bar line nearest its middle
            mid = (lo_t + hi_t) / 2
            cands = [min((i for i in range(i0, len(times)) if (i - db) % 4 == 0), key=lambda i: abs(times[i] - mid))]
        end_t = _to_s(nxt["e"], fps)
        best, best_score = cands[0], -np.inf
        for i in cands:
            sw = times[i]
            mine = np.array([t for t in times[i0:i] if t >= lo_t - 8 * period0])
            n0 = nxt["phase"] + pn * np.ceil((sw - pn / 2 - nxt["phase"]) / pn)
            theirs = n0 + pn * np.arange(int(max(0.0, end_t - n0) / pn) + 1)
            theirs = theirs[theirs <= hi_t + 8 * pn]
            score = _hits(o, to_frame(mine), base).sum() + _hits(o, to_frame(theirs), base).sum()
            if score >= best_score - 0.05:  # ties (a beatless breakdown): switch as late as possible, where the new drums start
                best, best_score = i, score
        sw = times[best]
        n0 = nxt["phase"] + pn * np.ceil((sw - pn / 2 - nxt["phase"]) / pn)
        n0 = max(n0, times[best - 1] + 0.5 * min(pn, 60.0 / cur["bpm"])) if best > 0 else n0
        times = times[:best] + list(n0 + pn * np.arange(int(max(0.0, dur - n0) / pn) + 1))
        starts.append((best, nxt["bpm"]))
        period0 = pn

    # it has to beat one steady tempo clearly, or the "sections" were the detector guessing
    t_all = np.array(times)
    p1 = 60.0 / bpm
    steady = t0 + p1 * np.arange(int((dur - t0) / p1) + 1)
    if _hits(o, to_frame(t_all), base).mean() < 1.15 * _hits(o, to_frame(steady), base).mean():
        return None

    longest = max(range(len(starts)), key=lambda k: (starts[k + 1][0] if k + 1 < len(starts) else len(times)) - starts[k][0])
    return {
        "bpm": starts[longest][1], "first_beat_ms": round(times[0] * 1000.0, 2), "downbeat": db,
        "beats_ms": [round(float(t) * 1000.0, 2) for t in times],
        "tempos": [{"ms": round(float(times[i]) * 1000.0, 1), "bpm": float(b)} for i, b in starts],
    }
