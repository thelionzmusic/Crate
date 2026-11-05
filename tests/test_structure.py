"""Phrase detection and auto cues against an arrangement with known sections."""
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from crate.analysis import analyse_file  # noqa: E402
from crate.analysis.structure import auto_cues, phrases  # noqa: E402
from synth import structured, write  # noqa: E402


def main() -> int:
    fails = 0
    # offsets chosen so the first beat is beat 1, 2 and 4 of the bar: bars must still line up
    for bpm, off in ((126.0, 0.25), (128.0, 0.9 + 60 / 128), (174.0, 0.1 + 3 * 60 / 174)):
        x, plan = structured(bpm, off)
        with tempfile.TemporaryDirectory() as d:
            p = write(Path(d) / "s.wav", x)
            r = analyse_file(str(p), 88.0, -10.0, -1.0)
        wave = np.frombuffer(r["wave"], np.uint8).reshape(-1, 3)
        dur = len(x) / 44100
        got = phrases(wave, r["bpm"], r["first_beat_ms"], r["downbeat"], dur)
        want = [(lab, b) for lab, b in plan]
        have = [(p["label"], p["bars"]) for p in got]
        bar_ms = 240000 / bpm
        starts_ok = all(abs(p["start_ms"] - (off * 1000 + sum(b for _, b in plan[:k]) * bar_ms)) < 15 for k, p in enumerate(got))
        ok = have == want and starts_ok
        fails += not ok
        print(("PASS" if ok else "FAIL"), f"{bpm} bpm  want {want}\n      got  {have}")
        cues = auto_cues(got)
        hot = [(c["slot"], c["name"], round(c["start_ms"] / (240000 / bpm))) for c in cues if c["slot"]]
        print("      hot cues (slot, name, bar):", hot)
    print("all passed" if not fails else f"{fails} failed")
    return fails


if __name__ == "__main__":
    sys.exit(main())
