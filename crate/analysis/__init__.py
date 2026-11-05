"""Per-track analysis, built to run in a process pool (one track per core)."""
from __future__ import annotations

import time
import traceback

import numpy as np
from scipy.signal import resample_poly

from .. import audio
from . import key, loudness, structure, tempo, waveform

SR = 44100
SR_LOW = 11025


def analyse_file(path: str, bpm_min: float, target_lufs: float, ceiling: float) -> dict:
    """Decode once and run every analysis on the shared buffer. Never raises."""
    t = time.perf_counter()
    try:
        x = audio.decode(path, SR)
        if len(x) < SR:
            raise ValueError("track shorter than one second")
        mono = x.mean(axis=1)
        lufs = loudness.integrated_lufs(x, SR)
        peak = loudness.true_peak_db(x)
        gain, capped = loudness.level_gain(lufs, peak, target_lufs, ceiling)
        low = resample_poly(mono, 1, SR // SR_LOW).astype(np.float32)
        beats = tempo.analyse(low, SR_LOW, bpm_min)
        k = key.detect(low, SR_LOW)
        wave = waveform.compute(mono, SR)
        beats["downbeat"] = structure.refine_downbeat(wave, beats["bpm"], beats["first_beat_ms"], beats["downbeat"])
        return {
            "ok": True, "path": path,
            "lufs": round(lufs, 2), "true_peak": round(peak, 2), "gain_db": gain, "gain_capped": int(capped),
            **beats, **k,
            "wave": wave.tobytes(), "wave_len": len(wave),
            "seconds": round(time.perf_counter() - t, 2),
        }
    except Exception as e:  # report, don't kill the pool
        return {"ok": False, "path": path, "error": f"{type(e).__name__}: {e}",
                "trace": traceback.format_exc(limit=3)}
