"""Quality checks, energy, vocal regions, variable tempo and mix points against known signals."""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from synth import SR, hz, track, write  # noqa: E402

from crate import audio  # noqa: E402
from crate.analysis import analyse_file, structure  # noqa: E402

fails = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


def analyse(p: Path) -> dict:
    info = audio.probe(p)
    r = analyse_file(str(p), 88.0, -10.0, -1.0, info)
    assert r["ok"], r
    return r


def voice(seconds: float, seed: int = 0) -> np.ndarray:
    """A sung line: gliding pitch, vibrato, syllable gaps, formant-ish harmonics."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * SR)) / SR
    notes = hz(9, 3) * 2 ** (rng.integers(0, 8, size=int(seconds * 2) + 1) / 12)
    f0 = np.repeat(notes, int(SR / 2))[: len(t)]
    f0 = np.convolve(f0, np.ones(2000) / 2000, mode="same") * (1 + 0.02 * np.sin(2 * np.pi * 5.5 * t))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    sig = sum(np.sin(k * phase) / k for k in range(1, 7))
    env = (np.sin(2 * np.pi * 2 * t) > -0.3).astype(float)  # syllables
    return sig * np.convolve(env, np.ones(400) / 400, mode="same") * 0.18


def ramp_track(b0: float, b1: float, seconds: float) -> tuple[np.ndarray, np.ndarray]:
    """Kicks on a tempo that ramps linearly from b0 to b1. Returns (audio, true beat times)."""
    times, t = [], 0.3
    while t < seconds - 1:
        times.append(t)
        bpm = b0 + (b1 - b0) * t / seconds
        t += 60.0 / bpm
    n = int(seconds * SR)
    out = np.zeros(n)
    tk = np.arange(int(0.2 * SR)) / SR
    kick = np.sin(2 * np.pi * (50 + 120 * np.exp(-tk * 30)) * tk) * np.exp(-tk * 9)
    for i, bt in enumerate(times):
        s = int(bt * SR)
        out[s:s + len(kick)] += kick[:max(0, min(len(kick), n - s))] * (1.0 if i % 4 == 0 else 0.8)
    x = np.stack([out, out], axis=1) * 0.5
    return x.astype(np.float32), np.array(times) * 1000


def main() -> int:
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        base = track(126, 0.2, "A", True, seconds=60)
        # quality: genuine 320 vs a 128 kbps file re-encoded as 320
        real = write(d / "real.mp3", base, "libmp3lame")
        low = write(d / "low.mp3", base, "libmp3lame")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(d / "real.mp3"), "-b:a", "128k", str(low)], check=True)
        fake = d / "fake.mp3"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(low), "-b:a", "320k", str(fake)], check=True)
        r_real, r_fake = analyse(real), analyse(fake)
        print(f"     bandwidth real {r_real['quality']['bandwidth_hz']} Hz, fake {r_fake['quality']['bandwidth_hz']} Hz")
        check(not r_real["quality"]["issues"], f"genuine 320 has no issues {r_real['quality']['issues']}")
        check(any("upscaled" in i for i in r_fake["quality"]["issues"]), "128 kbps re-encoded as 320 is flagged as upscaled")
        r_low = analyse(low)
        check(any("Low bitrate" in i for i in r_low["quality"]["issues"]), "128 kbps file flagged as low bitrate")
        clipped = write(d / "clip.wav", np.clip(base * 6, -1, 1).astype(np.float32))
        check(any("Clipped" in i for i in analyse(clipped)["quality"]["issues"]), "clipped master flagged")
        check(not analyse(write(d / "clean.wav", base))["quality"]["issues"], "clean WAV has no issues")

        # energy: soft and slow vs loud and fast
        soft = analyse(write(d / "soft.wav", track(100, 0.2, "A", True, seconds=60, gain_db=-14)))["energy"]
        hard = analyse(write(d / "hard.wav", track(140, 0.2, "A", True, seconds=60, gain_db=0)))["energy"]
        check(1 <= soft < hard <= 10, f"energy orders tracks (soft {soft}, hard {hard})")

        # vocals: pads for 30 s, a sung line for 30 s, pads again
        x = track(124, 0.2, "A", True, seconds=90).astype(np.float64)
        a, b = int(30 * SR), int(60 * SR)
        x[a:b] += voice(30)[:, None]
        r = analyse(write(d / "vox.wav", np.clip(x, -1, 1).astype(np.float32)))
        sung = sum(max(0, min(e, 60000) - max(s, 30000)) for s, e in r["vocals"]) / 30000
        false = sum(max(0, min(e, 30000) - s) + max(0, e - max(s, 60000)) for s, e in r["vocals"]) / 60000
        check(sung > 0.7 and false < 0.1, f"vocals found {sung:.0%} of the sung part, {false:.0%} false elsewhere {r['vocals']}")
        check(analyse(write(d / "novox.wav", track(124, 0.2, "A", True, seconds=60)))["vocals"] == [], "no vocals reported on an instrumental")

        # variable tempo: 120 -> 124 BPM ramp tracked to the beat; steady tracks stay constant
        x, truth = ramp_track(120, 124, 150)
        r = analyse(write(d / "ramp.wav", x))
        beats = np.array(r["beats_ms"] or [])
        if len(beats):
            err = np.array([np.min(np.abs(beats - t)) for t in truth[4:-4]])
            check(np.percentile(err, 95) < 15, f"drifting tempo tracked, 95% of beats within {np.percentile(err, 95):.1f} ms")
        else:
            check(False, "drifting tempo detected")
        check(r_real["beats_ms"] is None, "steady track keeps a constant grid")

        # mix points avoid vocals in the outro
        phr = [{"start_ms": 0, "end_ms": 30000, "label": "Intro"}, {"start_ms": 30000, "end_ms": 60000, "label": "Drop"},
               {"start_ms": 60000, "end_ms": 75000, "label": "Outro"}, {"start_ms": 75000, "end_ms": 90000, "label": "Outro"}]
        m = structure.mix_points(phr, [(61000, 70000)])
        check(m == {"mix_in_ms": 0, "mix_out_ms": 75000}, f"mix-out waits for the vocal to end {m}")
    print("all passed" if not fails else f"{len(fails)} failed")
    return len(fails)


if __name__ == "__main__":
    sys.exit(main())
