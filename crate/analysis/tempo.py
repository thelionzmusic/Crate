"""Tempo, beat phase and downbeat for a constant-tempo beatgrid.

Pipeline: log-spectral-flux onset envelope -> autocorrelation with bar-level harmonics
for the coarse tempo -> phase-folding sharpness for a 0.01 BPM refinement -> folded
kick-band envelope for the downbeat.
"""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

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
    o, low, bass, fps = onset_envelopes(x, sr)
    if len(o) < fps * 8 or o.max() == 0:
        return {"bpm": 0.0, "first_beat_ms": 0.0, "downbeat": 0}
    bpm = estimate_bpm(o, fps, bpm_min)
    t0 = beat_phase(o, low, fps, bpm)
    db = downbeat(bass, fps, bpm, t0)
    return {"bpm": bpm, "first_beat_ms": round(t0 * 1000.0, 2), "downbeat": db}


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


def variable_beats(x: np.ndarray, sr: int, bpm: float, first_beat_ms: float) -> list[float] | None:
    """Beat times (ms) for tracks whose tempo drifts by more than 0.3%; None for steady ones."""
    o, low, _, fps = onset_envelopes(x, sr)
    if bpm <= 0 or len(o) < fps * 60 or drift(o, fps, bpm) < 0.003:
        return None
    frames = track_beats(o + 2.0 * low, fps, bpm)
    if len(frames) < 32:
        return None
    t = (frames / fps + (N_FFT / 2) / sr - LATENCY_S) * 1000.0
    return [round(v, 2) for v in t if v >= 0]
