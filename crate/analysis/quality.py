"""Sound-quality checks: what a club system would expose before the crowd hears it.

* Upscaled files: a "320" or lossless file whose audio stops at ~16 kHz was made from a
  low-bitrate MP3. Encoders cut the top end, and re-encoding can't bring it back.
* Low bitrate: lossy files under 256 kbps.
* Clipping: runs of consecutive samples pinned at full scale.
* Low sample rate: under 44.1 kHz.
"""
from __future__ import annotations

import numpy as np

N_FFT = 8192
LOSSLESS = {"pcm", "flac", "alac"}


def bandwidth_hz(mono: np.ndarray, sr: int) -> float:
    """Where the audio's top end ends. Lossy encoders leave a sharp cliff (a lowpass at
    16 kHz for 128 kbps, ~19-20 kHz for 320); natural music rolls off gradually. Returns the
    lowest frequency with a cliff of 25 dB or more, or Nyquist when there's none."""
    if len(mono) < N_FFT * 4:
        return sr / 2
    starts = np.linspace(0, len(mono) - N_FFT, min(160, len(mono) // N_FFT)).astype(int)
    win = np.hanning(N_FFT).astype(np.float32)
    power = np.zeros(N_FFT // 2 + 1)
    for s in starts:
        power += np.abs(np.fft.rfft(mono[s:s + N_FFT] * win)) ** 2
    db = 10 * np.log10(power / len(starts) + 1e-20)
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    band = lambda a, b: db[(freqs >= a) & (freqs < b)].mean()  # noqa: E731
    for fc in np.arange(14000, min(21000, sr / 2 - 1800), 250):
        if band(fc - 1500, fc) - band(fc + 250, fc + 1750) >= 25:
            return float(fc)
    return sr / 2


def clip_events(x: np.ndarray, thresh: float = 0.999, run: int = 3) -> int:
    """Number of places where at least `run` consecutive samples sit at full scale."""
    hot = np.abs(x) >= thresh
    count = 0
    for ch in range(hot.shape[1]):
        h = hot[:, ch].astype(np.int8)
        edges = np.diff(np.concatenate(([0], h, [0])))
        starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
        count += int(np.sum(ends - starts >= run))
    return count


def assess(x: np.ndarray, sr: int, codec: str, bitrate: int, sample_rate: int, duration_s: float) -> dict:
    mono = x.mean(axis=1)
    bw = bandwidth_hz(mono, sr)
    clips = clip_events(x)
    lossless = codec in LOSSLESS
    issues = []
    if (lossless or bitrate >= 256) and bw < 16500:
        issues.append(f"Probably upscaled from a low-quality MP3: nothing above {bw / 1000:.1f} kHz")
    if not lossless and 0 < bitrate < 256:
        issues.append(f"Low bitrate ({bitrate} kbps): will sound dull on a big system")
    per_min = clips / max(duration_s / 60, 1e-6)
    if per_min >= 20:
        issues.append(f"Clipped master: flattened at full scale in {clips} places")
    if 0 < sample_rate < 44100:
        issues.append(f"Low sample rate ({sample_rate / 1000:.1f} kHz): missing top end")
    return {"bandwidth_hz": round(bw), "clip_events": clips, "issues": issues}
