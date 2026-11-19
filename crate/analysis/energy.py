"""Energy 1-10, from the waveform, loudness and tempo."""
from __future__ import annotations

import numpy as np

from .waveform import FPS


def rating(wave: np.ndarray, lufs: float, bpm: float) -> int:
    """Energy 1-10: how hard the track drives. Loudness, top-end drive, tempo, and how much
    of the track sits at full intensity."""
    if not len(wave):
        return 0
    w = wave.astype(np.float32) / 255.0
    sec = w[: len(w) // FPS * FPS].reshape(-1, FPS, 3).mean(axis=1)  # per second
    total = sec.mean(axis=1)
    full = float((total >= 0.75 * np.percentile(total, 95)).mean())
    hi = float(sec[:, 2].mean() / (sec.mean() + 1e-6))
    loud = np.clip((lufs + 16) / 10, 0, 1)
    tempo = np.clip((bpm - 95) / 80, 0, 1) if bpm else 0.5
    e = 0.4 * loud + 0.15 * np.clip(hi, 0, 1) + 0.2 * tempo + 0.25 * full
    return int(np.clip(round(1 + 9 * e), 1, 10))
