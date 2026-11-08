"""Phrase detection and auto cues against an arrangement with known sections."""
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from crate.analysis import analyse_file  # noqa: E402
from crate.analysis.structure import auto_cues, mix_points, phrases  # noqa: E402
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
        mix = mix_points(got, [])
        cues = auto_cues(got, mix, [(int(got[2]["start_ms"] + 1.5 * bar_ms), int(got[2]["end_ms"]))])
        hot = {c["slot"]: c for c in cues if c["slot"]}
        bar_of = lambda c: round((c["start_ms"] - off * 1000) / bar_ms)  # noqa: E731
        print("      hot cues:", {k: (c["name"], bar_of(c)) for k, c in hot.items()})
        # the plan is Intro 16, Build 8, Drop 16, Breakdown 16, Build 8, Drop 16, Outro 16
        layout_ok = (hot[1]["name"] == "Mix in" and bar_of(hot[1]) == 0 and hot[2]["name"] == "Build" and bar_of(hot[2]) == 16
                     and hot[3]["name"] == "Drop" and bar_of(hot[3]) == 24 and hot[4]["name"] == "Breakdown" and bar_of(hot[4]) == 40
                     and hot[5]["name"] == "Build 2" and bar_of(hot[5]) == 56 and hot[6]["name"] == "Drop 2" and bar_of(hot[6]) == 64
                     and hot[7]["name"] == "Mix out" and bar_of(hot[7]) == 80
                     and abs(hot[8]["end_ms"] - hot[8]["start_ms"] - 2 * bar_ms) < 2)
        vocal_marker = any(c["slot"] == 0 and c["name"] == "Vocal" and bar_of(c) == 25 for c in cues)
        ok2 = layout_ok and vocal_marker
        fails += not ok2
        print(("PASS" if ok2 else "FAIL"), "smart cue layout, intro loop and vocal marker")
    print("all passed" if not fails else f"{fails} failed")
    return fails


if __name__ == "__main__":
    sys.exit(main())
