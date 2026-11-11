"""Where the vocals are.

Harmonic/percussive separation (median filtering) leaves sustained, pitched sound. Pads
and chords are pitched too, but hold their notes; voices glide, bend and move between
syllables. So a vocal region is one with strong harmonic content in the vocal range that
keeps changing pitch.
"""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view


def median_filter(*a, **k):  # scipy loads on first use, so opening Crate doesn't wait for it
    from scipy.ndimage import median_filter as f
    return f(*a, **k)

N_FFT, HOP = 1024, 256
LOW_HZ, HIGH_HZ = 180.0, 3600.0


def regions(x: np.ndarray, sr: int, min_s: float = 2.0) -> list[tuple[int, int]]:
    """[(start_ms, end_ms)] of likely vocal passages from mono audio at `sr`."""
    if len(x) < sr * 10:
        return []
    win = np.hanning(N_FFT).astype(np.float32)
    frames = sliding_window_view(x, N_FFT)[::HOP]
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    band = (freqs >= LOW_HZ) & (freqs <= HIGH_HZ)
    S = np.concatenate([np.abs(np.fft.rfft(frames[s:s + 2048] * win, axis=1))[:, band]
                        for s in range(0, len(frames), 2048)]).astype(np.float32)
    harm = median_filter(S, size=(17, 1), mode="nearest")
    perc = median_filter(S, size=(1, 17), mode="nearest")
    H = S * (harm ** 2 / (harm ** 2 + perc ** 2 + 1e-12))
    level = H.sum(axis=1)
    # pitch movement: how much the harmonic spectrum's shape changes frame to frame
    norm = H / (level[:, None] + 1e-9)
    move = np.r_[0.0, np.abs(np.diff(norm, axis=0)).sum(axis=1)]
    fps = sr / HOP
    k = max(1, int(fps * 0.5))
    smooth = lambda v: np.convolve(v, np.ones(k) / k, mode="same")  # noqa: E731
    lvl, mv = smooth(level), smooth(move)
    lvl = lvl / (np.percentile(lvl, 95) + 1e-9)
    score = np.clip(lvl, 0, 1.5) * mv
    if score.max() <= 0:
        return []
    thr = max(0.12, 0.45 * np.percentile(score, 98))
    on = score > thr
    edges = np.diff(np.concatenate(([0], on.astype(np.int8), [0])))
    out = []
    for a, b in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        if (b - a) / fps >= min_s:
            out.append((int(a / fps * 1000), int(b / fps * 1000)))
    merged = []  # bridge short gaps between phrases of one vocal line
    for a, b in out:
        if merged and a - merged[-1][1] < 1500:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    return merged
