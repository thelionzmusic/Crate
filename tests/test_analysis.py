"""Ground-truth checks for tempo, phase, downbeat, key and loudness."""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from synth import track, write  # noqa: E402

from crate.analysis import analyse_file  # noqa: E402

CASES = [  # bpm, first beat (s), tonic, minor, gain
    (128.0, 0.137, "A", True, 0.0),
    (124.0, 0.481, "F", True, -9.0),
    (174.0, 0.050, "D", False, -3.0),
    (120.0, 0.300, "G", False, -14.0),
    (140.0, 0.222, "C#", True, -6.0),
    (100.0, 0.600, "E", True, 0.0),
]


def ffmpeg_lufs(path: Path) -> float:
    err = subprocess.run(["ffmpeg", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", err)[-1])


def main() -> int:
    fails = 0
    with tempfile.TemporaryDirectory() as d:
        for n, (bpm, off, tonic, minor, gain) in enumerate(CASES):
            for codec, ext in (("pcm_s16le", "wav"), ("libmp3lame", "mp3")):
                p = write(Path(d) / f"t{n}.{ext}", track(bpm, off, tonic, minor, gain_db=gain, seed=n), codec)
                r = analyse_file(str(p), 88.0, -10.0, -1.0)
                assert r["ok"], r
                beat_ms = 60000 / bpm
                phase_err = (r["first_beat_ms"] - off * 1000 + beat_ms / 2) % beat_ms - beat_ms / 2
                want_key = f"{tonic}{'m' if minor else ''}"
                ref = ffmpeg_lufs(p)
                exp_bpm = bpm if bpm < 176 else bpm / 2
                ok_bpm = abs(r["bpm"] - exp_bpm) < 0.02
                # CDJs play MP3s without gapless trimming, so the grid should include LAME's 1105-sample delay.
                if ext == "mp3":
                    phase_err -= 1105 / 44.1
                ok_phase = abs(phase_err) < 5
                expected_db = 0  # synth's beat 0 is the downbeat
                beat0 = round((r["first_beat_ms"] - off * 1000) / beat_ms)  # beats before truth (neg) / after
                ok_db = (r["downbeat"] + beat0) % 4 == expected_db
                ok_lufs = abs(r["lufs"] - ref) < 0.3
                ok_key = r["key"] == want_key
                status = all([ok_bpm, ok_phase, ok_db, ok_lufs, ok_key])
                fails += not status
                print(f"{'PASS' if status else 'FAIL'} {ext} bpm {r['bpm']:7.2f}/{exp_bpm:<6} phase {phase_err:+6.1f}ms "
                      f"db {r['downbeat']}{'' if ok_db else '!'} key {r['key']:>4}/{want_key:<4} {r['camelot']:>3} "
                      f"lufs {r['lufs']:6.2f}/{ref:6.2f} tp {r['true_peak']:5.2f} gain {r['gain_db']:+5.2f} "
                      f"{r['seconds']:.2f}s")
    print("all passed" if not fails else f"{fails} failed")
    return fails


if __name__ == "__main__":
    sys.exit(main())
