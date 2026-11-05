"""Three-band waveform at 150 points per second, the resolution CDJs scroll at."""
from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfilt

FPS = 150


def compute(mono: np.ndarray, sr: int) -> np.ndarray:
    """(n, 3) uint8 peak heights for low / mid / high, normalised to the track."""
    hop = sr // FPS
    n = len(mono) // hop
    if n == 0:
        return np.zeros((0, 3), np.uint8)
    filters = [butter(4, 200, "lowpass", fs=sr, output="sos"),
               butter(4, [200, 2500], "bandpass", fs=sr, output="sos"),
               butter(4, 2500, "highpass", fs=sr, output="sos")]
    states = [np.zeros((len(f), 2)) for f in filters]
    out = np.zeros((n, 3), np.float32)
    chunk = hop * 4096
    for s in range(0, n * hop, chunk):
        seg = mono[s:min(s + chunk, n * hop)]
        row = s // hop
        for b, f in enumerate(filters):
            y, states[b] = sosfilt(f, seg, zi=states[b])
            out[row:row + len(y) // hop, b] = np.abs(y).reshape(-1, hop).max(axis=1)
    peak = np.percentile(out.max(axis=1), 99.5) or 1.0
    return np.clip(out / peak * 255.0, 0, 255).astype(np.uint8)


def resample(wave: np.ndarray, width: int) -> np.ndarray:
    """Max-pool a (n, 3) waveform down to `width` columns for previews."""
    if len(wave) == 0:
        return np.zeros((width, 3), np.uint8)
    if len(wave) <= width:
        return wave[(np.arange(width) * len(wave) // width)]
    return np.maximum.reduceat(wave, np.arange(width) * len(wave) // width, axis=0)
