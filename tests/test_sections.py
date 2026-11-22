"""Song sections and the cue points placed from them, on a synthetic track with a known
structure: intro, breakdown, build, drop, breakdown, build, drop, outro."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from crate.analysis import sections  # noqa: E402
from crate.analysis.waveform import FPS  # noqa: E402

BPM, BAR = 128, 60 / 128 * 4


def part(kind: str, bars: int) -> np.ndarray:
    m = int(bars * BAR * FPS)
    t = np.linspace(0, 1, m)
    flat = lambda lo, mid, hi: np.stack([np.full(m, lo), np.full(m, mid), np.full(m, hi)], 1)  # noqa: E731
    return {"intro": flat(70, 50, 40), "breakdown": flat(15, 80, 60), "drop": flat(220, 190, 170), "outro": flat(70, 50, 40),
            "build": np.stack([15 + 20 * t, 80 + 60 * t, 60 + 150 * t], 1)}[kind]


def main() -> int:
    plan = [("intro", 16), ("breakdown", 8), ("build", 8), ("drop", 16), ("breakdown", 16), ("build", 8), ("drop", 16), ("outro", 16)]
    w = np.concatenate([part(k, n) for k, n in plan])
    w = np.clip(w + np.random.default_rng(1).integers(0, 8, w.shape), 0, 255).astype(np.uint8)
    starts = np.arange(0, len(w) / FPS - BAR + 1e-6, BAR)
    phr = sections.phrases(w, starts, len(w) / FPS)
    got = [(p["label"], p["start_bar"]) for p in phr]
    want = [("Intro", 0), ("Breakdown", 16), ("Build", 24), ("Drop", 32), ("Breakdown", 48), ("Build", 64), ("Drop", 72), ("Outro", 88)]
    fails = 0 if got == want else 1
    print(f"{'ok  ' if not fails else 'FAIL'} sections {got}")
    hot = [(c["slot"], c["name"]) for c in sections.cue_points(phr) if c["slot"]]
    ok = hot == [(1, "Intro"), (2, "Breakdown"), (3, "Build"), (4, "Drop"), (5, "Breakdown 2"), (6, "Build 2"), (7, "Drop 2"), (8, "Outro")]
    fails += not ok
    print(f"{'ok  ' if ok else 'FAIL'} hot cues in order {hot}")
    print("all passed" if not fails else f"{fails} failed")
    return fails


if __name__ == "__main__":
    sys.exit(main())
