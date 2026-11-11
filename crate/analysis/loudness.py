"""EBU R128 / ITU-R BS.1770-4 integrated loudness and 4x-oversampled true peak.

Processes in chunks with carried filter state, so memory stays flat however long the track.
"""
from __future__ import annotations

import numpy as np


def resample_poly(*a, **k):  # scipy loads on first use, so opening Crate doesn't wait for it
    from scipy.signal import resample_poly as f
    return f(*a, **k)


def sosfilt(*a, **k):  # scipy loads on first use, so opening Crate doesn't wait for it
    from scipy.signal import sosfilt as f
    return f(*a, **k)

CHUNK = 1 << 20


def _k_weighting(fs: int) -> np.ndarray:
    """BS.1770 pre-filter (high shelf + RLB high-pass) for any sample rate."""
    # Stage 1: high shelf, +4 dB at ~1.68 kHz
    A, Q, fc = 10 ** (4.0 / 40), 0.7071752369554193, 1681.974450955533
    w = 2 * np.pi * fc / fs
    c, al = np.cos(w), np.sin(w) / (2 * Q)
    r = 2 * np.sqrt(A) * al
    b1 = [A * ((A + 1) + (A - 1) * c + r), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - r)]
    a1 = [(A + 1) - (A - 1) * c + r, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - r]
    # Stage 2: high-pass at ~38 Hz (numerator unnormalised, as in the ITU coefficients)
    Q, fc = 0.5003270373253953, 38.13547087613982
    w = 2 * np.pi * fc / fs
    c, al = np.cos(w), np.sin(w) / (2 * Q)
    b2, a2 = [1.0, -2.0, 1.0], [1 + al, -2 * c, 1 - al]
    return np.array([np.r_[np.divide(b1, a1[0]), np.divide(a1, a1[0])],
                     np.r_[b2, np.divide(a2, a2[0])]])


def integrated_lufs(x: np.ndarray, fs: int) -> float:
    """Gated integrated loudness of a (n, ch) signal, in LUFS."""
    sos = _k_weighting(fs)
    zi = np.zeros((len(sos), 2, x.shape[1]))
    hop = int(round(0.1 * fs))  # 100 ms; a 400 ms block is four hops (75% overlap)
    seg_energy: list[np.ndarray] = []
    carry = np.zeros(0)
    for s in range(0, len(x), CHUNK):
        y, zi = sosfilt(sos, x[s:s + CHUNK].astype(np.float64), axis=0, zi=zi)
        p = np.concatenate([carry, np.square(y).sum(axis=1)])
        n = len(p) // hop * hop
        seg_energy.append(p[:n].reshape(-1, hop).sum(axis=1))
        carry = p[n:]
    seg = np.concatenate(seg_energy) if seg_energy else np.zeros(0)
    if len(seg) < 4:
        return -70.0
    blocks = (seg[:-3] + seg[1:-2] + seg[2:-1] + seg[3:]) / (4 * hop)
    loud = -0.691 + 10 * np.log10(blocks + 1e-20)
    blocks, loud = blocks[loud > -70], loud[loud > -70]
    if not blocks.size:
        return -70.0
    rel = -0.691 + 10 * np.log10(blocks.mean()) - 10
    gated = blocks[loud > rel]
    return float(-0.691 + 10 * np.log10(gated.mean())) if gated.size else -70.0


def true_peak_db(x: np.ndarray) -> float:
    """dBTP via 4x polyphase oversampling, run only on the blocks that can hold the true peak."""
    blk = 4096
    n = len(x) // blk * blk
    if n == 0:
        return float(20 * np.log10(max(np.abs(x).max(initial=0.0), 1e-6)))
    peaks = np.abs(x[:n].reshape(-1, blk, x.shape[1])).max(axis=(1, 2))
    tail = np.abs(x[n:]).max(initial=0.0)
    top = max(peaks.max(), tail)
    if top <= 0:
        return -120.0
    tp = float(top)
    # Inter-sample overs exceed the sample peak by well under 3 dB in practice.
    hot = np.flatnonzero(peaks >= top * 10 ** (-3 / 20))
    pad = 32
    for i in hot:
        s = i * blk
        seg = x[max(0, s - pad):s + blk + pad].astype(np.float32)
        tp = max(tp, float(np.abs(resample_poly(seg, 4, 1, axis=0)).max()))
    return float(20 * np.log10(tp))


def level_gain(lufs: float, true_peak: float, target: float, ceiling: float) -> tuple[float, bool]:
    """Gain to reach `target` LUFS without the true peak passing `ceiling` dBTP.

    Pure gain, no limiting, so it can never distort. Returns (gain_db, capped).
    """
    want = target - lufs
    room = ceiling - true_peak
    return (round(room, 2), True) if want > room else (round(want, 2), False)


def auto_target(lufs: list[float], peaks: list[float], ceiling: float,
                percentile: float = 10.0, lo: float = -14.0, hi: float = -8.0) -> float:
    """Loudest target that ~90% of tracks can reach with pure gain under the ceiling."""
    reach = [l + (ceiling - p) for l, p in zip(lufs, peaks) if l > -70]
    if not reach:
        return -10.0
    return float(np.clip(np.percentile(reach, percentile), lo, hi).round(1))
