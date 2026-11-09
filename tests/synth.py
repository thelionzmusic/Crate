"""Synthetic dance tracks with known ground truth, for testing analysis."""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

SR = 44100
NOTE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def hz(pc: int, octave: int) -> float:
    return 440.0 * 2 ** ((pc + 12 * (octave + 1) - 69) / 12)


def track(bpm: float, offset_s: float, tonic: str, minor: bool, seconds: float = 90.0,
          gain_db: float = 0.0, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    out = np.zeros(n, np.float64)
    beat = 60.0 / bpm
    t_kick = np.arange(int(0.25 * SR)) / SR
    kick = np.sin(2 * np.pi * (50 + 120 * np.exp(-t_kick * 30)) * t_kick) * np.exp(-t_kick * 9)
    hat = rng.standard_normal(int(0.04 * SR)) * np.exp(-np.arange(int(0.04 * SR)) / SR * 90) * 0.25
    root = NOTE[tonic]
    third = 3 if minor else 4
    chord = [root, (root + third) % 12, (root + 7) % 12]
    t_all = np.arange(n) / SR
    pad = sum(np.sin(2 * np.pi * hz(pc, 4) * t_all) for pc in chord) * 0.06
    pad += np.sin(2 * np.pi * hz(root, 3) * t_all) * 0.05
    out += pad
    i = 0
    while True:
        t = offset_s + i * beat
        s = int(round(t * SR))
        if s >= n:
            break
        amp = 1.0 if i % 4 == 0 else 0.8  # downbeat accent
        e = min(n, s + len(kick))
        out[s:e] += kick[:e - s] * amp
        if i % 4 == 0:  # sub bass hit on the one
            tb = np.arange(min(int(0.4 * SR), n - s)) / SR
            out[s:s + len(tb)] += np.sin(2 * np.pi * hz(root, 1) * tb) * np.exp(-tb * 4) * 0.5
        h = int(round((t + beat / 2) * SR))
        if h < n:
            e = min(n, h + len(hat))
            out[h:e] += hat[:e - h]
        i += 1
    out *= 0.5 * 10 ** (gain_db / 20)
    stereo = np.stack([out, out * 0.97], axis=1)
    return np.clip(stereo, -1, 1).astype(np.float32)


def write(path: Path, x: np.ndarray, codec: str = "pcm_s16le") -> Path:
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
           "-metadata", f"title={path.stem}", "-metadata", "artist=Test Artist", "-metadata", "album=Test EP",
           "-metadata", "genre=Techno", "-c:a", codec]
    if codec == "libmp3lame":
        cmd += ["-b:a", "320k"]
    subprocess.run(cmd + [str(path)], input=x.tobytes(), check=True)
    return path


def structured(bpm: float = 126.0, offset_s: float = 0.25, seed: int = 0):
    """A dance track with a known arrangement. Returns (audio, [(label, bars), ...])."""
    plan = [("Intro", 16), ("Build", 8), ("Drop", 16), ("Breakdown", 16), ("Build", 8), ("Drop", 16), ("Outro", 16)]
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    total_beats = sum(b for _, b in plan) * 4
    n = int((offset_s + total_beats * beat + 1.0) * SR)
    out = np.zeros(n)
    t_k = np.arange(int(0.25 * SR)) / SR
    kick = np.sin(2 * np.pi * (50 + 120 * np.exp(-t_k * 30)) * t_k) * np.exp(-t_k * 9)
    hat = rng.standard_normal(int(0.04 * SR)) * np.exp(-np.arange(int(0.04 * SR)) / SR * 90) * 0.2
    t_b = np.arange(int(beat * SR)) / SR
    bass = np.sin(2 * np.pi * hz(9, 1) * t_b) * np.minimum(1, t_b * 40) * np.exp(-t_b * 2) * 0.5
    beat_i = 0
    for label, nbars in plan:
        start_beat = beat_i
        for k in range(nbars * 4):
            s = int(round((offset_s + beat_i * beat) * SR))
            prog = k / (nbars * 4)
            if label in ("Intro", "Drop", "Outro") or (label == "Build" and start_beat < 40 * 4):
                out[s:s + len(kick)] += kick[:max(0, min(len(kick), n - s))]
            if label in ("Build", "Drop", "Outro"):
                h = s + int(beat / 2 * SR)
                amp = (0.3 + prog) if label == "Build" else 1.0
                out[h:h + len(hat)] += hat[:max(0, min(len(hat), n - h))] * amp
            if label == "Drop":
                out[s:s + len(bass)] += bass[:max(0, min(len(bass), n - s))]
            seg = slice(s, min(n, s + int(beat * SR)))
            t = np.arange(seg.stop - seg.start) / SR + beat_i * beat
            if label in ("Breakdown", "Drop", "Build"):
                lvl = {"Breakdown": 0.12, "Drop": 0.1, "Build": 0.04 + 0.12 * prog}[label]
                out[seg] += sum(np.sin(2 * np.pi * hz(pc, 4) * t) for pc in (9, 0, 4)) * lvl
            beat_i += 1
    out *= 0.45
    return np.clip(np.stack([out, out], axis=1), -1, 1).astype(np.float32), plan


def tempo_change(plan: list[tuple], offset_s: float = 0.31, seed: int = 0, drift: float = 0.0):
    """A track whose tempo changes on bar lines: plan = [(bpm, bars[, drums]), ...];
    drums=False makes that part a beatless breakdown (pads only).
    drift > 0 instead wobbles one tempo slowly (a live drummer), for the negative case.
    Returns (audio, beat times in s); beat 0 is a downbeat."""
    rng = np.random.default_rng(seed)
    times, drums, t = [], [], offset_s
    for bpm, nbars, *rest in plan:
        for _ in range(nbars * 4):
            times.append(t)
            drums.append(rest[0] if rest else True)
            local = bpm * (1 + drift * np.sin(2 * np.pi * len(times) / 300)) if drift else bpm
            t += 60.0 / local
    n = int((t + 1.0) * SR)
    out = np.zeros(n)
    t_k = np.arange(int(0.25 * SR)) / SR
    kick = np.sin(2 * np.pi * (50 + 120 * np.exp(-t_k * 30)) * t_k) * np.exp(-t_k * 9)
    hat = rng.standard_normal(int(0.04 * SR)) * np.exp(-np.arange(int(0.04 * SR)) / SR * 90) * 0.25
    t_all = np.arange(n) / SR
    out += sum(np.sin(2 * np.pi * hz(pc, 4) * t_all) for pc in (9, 0, 4)) * 0.05
    for i, bt in enumerate(times):
        if not drums[i]:
            continue
        s = int(round(bt * SR))
        e = min(n, s + len(kick))
        out[s:e] += kick[:e - s] * (1.0 if i % 4 == 0 else 0.8)
        if i % 4 == 0:
            tb = np.arange(min(int(0.4 * SR), n - s)) / SR
            out[s:s + len(tb)] += np.sin(2 * np.pi * hz(9, 1) * tb) * np.exp(-tb * 4) * 0.5
        nxt = times[i + 1] if i + 1 < len(times) else bt + (bt - times[i - 1])
        h = int(round((bt + nxt) / 2 * SR))
        if h < n:
            e = min(n, h + len(hat))
            out[h:e] += hat[:e - h]
    out *= 0.5
    return np.clip(np.stack([out, out * 0.97], axis=1), -1, 1).astype(np.float32), times
