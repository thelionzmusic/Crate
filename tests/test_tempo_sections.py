"""Tracks that change tempo get a grid per section, switching on the right bar;
steady and live-drifting tracks don't get mistaken for them."""
import struct
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from synth import tempo_change, track, write  # noqa: E402

from crate import audio  # noqa: E402
from crate.analysis import analyse_file, tempo_file  # noqa: E402
from crate.export import anlz  # noqa: E402
from crate.library import Library  # noqa: E402

CASES = [  # name, plan [(bpm, bars)], expected tempos
    ("128 to 140", [(128, 40), (140, 40)], [128, 140]),
    ("174 to 160 to 174", [(174, 48), (160, 32), (174, 48)], [174, 160, 174]),
    ("124 to 126", [(124, 48), (126, 48)], [124, 126]),
    ("100 to 128", [(100, 24), (128, 48)], [100, 128]),
    ("128, breakdown, 140", [(128, 32), (128, 8, False), (140, 40)], [128, 140]),
    ("136 to 132 (mp3)", [(136, 40), (132, 40)], [136, 132]),
]


def cdj_tempos(r):
    """The tempos written into the CDJ beat grid (PQTZ), per beat, in hundredths of a BPM."""
    beats = [(((i - r["downbeat"]) % 4) + 1, ms) for i, ms in enumerate(r["beats_ms"] or [])]
    tag = anlz._grid(beats, r["bpm"], r.get("tempos"))
    return [struct.unpack(">H", tag[24 + 8 * i + 2:24 + 8 * i + 4])[0] for i in range(len(beats))]


def check(name, ok, detail):
    print(f"{'PASS' if ok else 'FAIL'} {name:<22} {detail}")
    return 0 if ok else 1


def main() -> int:
    fails = 0
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:  # Windows keeps the library's files locked
        for n, (name, plan, want) in enumerate(CASES):
            x, truth = tempo_change(plan, seed=n)
            mp3 = "mp3" in name
            r = analyse_file(str(write(Path(d) / f"s{n}.{'mp3' if mp3 else 'wav'}", x, "libmp3lame" if mp3 else "pcm_s16le")), 88.0, -10.0, -1.0)
            if mp3:  # CDJs play MP3s with LAME's 1105-sample delay, and so does the grid
                truth = [t + 1105 / 44100 for t in truth]
            got = [round(t["bpm"], 2) for t in (r.get("tempos") or [])]
            ok_tempos = len(got) == len(want) and all(abs(g - w) < 0.05 for g, w in zip(got, want))
            beats = np.array(r.get("beats_ms") or [0.0]) / 1000
            truth = np.array(truth)
            playing = np.array([True] * len(truth))
            at = 0
            for bpm_, bars_, *rest in plan:
                playing[at:at + bars_ * 4] = rest[0] if rest else True
                at += bars_ * 4
            # every true beat has a grid beat within 5 ms, and nothing extra in between
            err = np.abs(beats[np.clip(np.searchsorted(beats, truth), 1, len(beats) - 1)[:, None] + np.array([-1, 0])] - truth[:, None]).min(axis=1)
            err_on = err[playing]
            ok_grid = err_on.max() < 0.005 and abs(len(beats[(beats >= truth[0] - 0.01) & (beats <= truth[-1] + 0.01)]) - len(truth)) <= 0
            # bars: the grid's downbeats land on the true ones (every 4th true beat), through every change
            first = int(np.argmin(np.abs(beats - truth[0])))
            db = [(i - r["downbeat"]) % 4 == 0 for i in range(first, first + len(truth), 4)]
            ok_bars = all(db)
            changes = [sum(p[1] * 4 for p in plan[:k]) for k in range(1, len(plan)) if plan[k][0] != plan[k - 1][0]]
            ok_switch = all(abs(t["ms"] / 1000 - truth[i]) < 0.005 for t, i in zip((r.get("tempos") or [])[1:], changes))
            tempos_out = cdj_tempos(r)
            ok_cdj = sorted(set(tempos_out)) == sorted({round(w * 100) for w in want})
            fails += check(name, ok_tempos and ok_grid and ok_bars and ok_switch and ok_cdj,
                           f"tempos {got} (want {want}), worst beat {err_on.max() * 1000:.1f} ms, bars {'ok' if ok_bars else 'OFF'}, "
                           f"switch {'ok' if ok_switch else 'OFF'}, CDJ {'ok' if ok_cdj else sorted(set(tempos_out))}, {r['seconds']:.1f}s")
        # negatives
        r = analyse_file(str(write(Path(d) / "steady.wav", track(126, 0.2, "A", True, seconds=180))), 88.0, -10.0, -1.0)
        fails += check("steady 126", not r.get("tempos") and not r.get("beats_ms") and abs(r["bpm"] - 126) < 0.02, f"bpm {r['bpm']}, tempos {r.get('tempos')}")
        x, _ = tempo_change([(128, 32), (128, 16, False), (128, 32)], seed=8)
        r = analyse_file(str(write(Path(d) / "breakdown.wav", x)), 88.0, -10.0, -1.0)
        fails += check("steady 128, breakdown", not r.get("tempos") and abs(r["bpm"] - 128) < 0.02, f"bpm {r['bpm']}, tempos {r.get('tempos')}")
        x, _ = tempo_change([(122, 90)], seed=9, drift=0.006)
        r = analyse_file(str(write(Path(d) / "live.wav", x)), 88.0, -10.0, -1.0)
        fails += check("live drift 122", not r.get("tempos") and bool(r.get("beats_ms")), f"bpm {r['bpm']}, tempos {r.get('tempos')}, tracked {bool(r.get('beats_ms'))}")
        # a library analysed before tempo sections: the background re-check finds them
        x, truth = tempo_change([(128, 40), (140, 40)], seed=11)
        f = write(Path(d) / "old.wav", x)
        lib = Library(Path(d) / "home")
        tid = lib.upsert(str(f), audio.probe(str(f)))
        old = analyse_file(str(f), 88.0, -10.0, -1.0)
        old.update(beats_ms=None, tempos=None, bpm=134.0)  # what the previous version stored
        lib.save_analysis(tid, old)
        lib.x("UPDATE tracks SET grid_ver = 0 WHERE id = ?", (tid,))
        stale = [r["id"] for r in lib.stale_grids()]
        changed = lib.regrid(tid, tempo_file(str(f), 88.0))
        t = lib.detail(tid)
        bars = [ms for pos, ms in lib.grid(t) if pos == 1]
        ok_bars = all(min(abs(b - truth[i] * 1000) for b in bars) < 5 for i in range(0, len(truth), 4))
        phr = t["phrases"]
        fails += check("old library re-checked", stale == [tid] and changed and [x["bpm"] for x in t["tempos"]] == [128, 140]
                       and ok_bars and phr and not lib.stale_grids(),
                       f"tempos {t['tempos']}, bars {'ok' if ok_bars else 'OFF'}, {len(phr)} phrases")
    print("all passed" if not fails else f"{fails} failed")
    return fails


if __name__ == "__main__":
    sys.exit(main())
