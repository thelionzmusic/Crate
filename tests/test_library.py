"""Library features end to end: smart playlists, set builder, duplicates, history, wishlist."""
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from crate import audio, setbuilder, smart, store  # noqa: E402
from crate.analysis import analyse_file  # noqa: E402
from crate.export import pdbread  # noqa: E402
from crate.export.devicesql import Table, build, dstr  # noqa: E402
from crate.jobs import Jobs  # noqa: E402
from crate.library import Library  # noqa: E402
from synth import structured, track, write  # noqa: E402

fails = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


def main() -> int:
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        lib = Library(d / "home")
        specs = [("A minor 124", 124, "A", True), ("E minor 125", 125, "E", True), ("C major 126", 126, "C", False),
                 ("D minor 127", 127, "D", True), ("F# minor 140", 140, "F#", True), ("G major 123", 123, "G", False)]
        ids = {}
        for name, bpm, k, minor in specs:
            p = write(d / f"{name}.wav", track(bpm, 0.2, k, minor, seconds=45, seed=bpm))
            info = audio.probe(p)
            tid = lib.upsert(str(p), info)
            lib.save_analysis(tid, analyse_file(str(p), 88, -10, -1, info))
            ids[name] = tid
        rows = lib.rows()
        cam = {t["title"]: t["camelot"] for t in rows}
        print("     keys:", cam)

        # smart playlists
        rules = smart.validate({"match": "all", "rules": [{"field": "bpm", "op": "between", "value": [123.5, 127.5]},
                                                          {"field": "camelot", "op": "compatible", "value": "8A"}]})
        got = set(smart.evaluate(rules, rows))
        want = {t["id"] for t in rows if 123.5 <= t["bpm"] <= 127.5 and smart._compatible(t["camelot"], "8A")}
        check(got == want and ids["A minor 124"] in got and ids["F# minor 140"] not in got, f"smart playlist rules ({len(got)} tracks)")
        nid = lib.create_node("Peak 8A", 0, False, rules)
        check(set(next(n for n in lib.nodes() if n["id"] == nid)["tracks"]) == got, "smart playlist stays current in the tree")
        try:
            smart.validate({"rules": [{"field": "path", "op": "contains", "value": "x"}]})
            check(False, "unknown smart field rejected")
        except ValueError:
            check(True, "unknown smart field rejected")

        # set builder: every step must mix (compatible key, tempo within 6%)
        s = setbuilder.build(rows, ids["A minor 124"], 6, "warmup")
        by = {t["id"]: t for t in rows}
        ok = all(setbuilder._key_fit(by[a]["camelot"], by[b]["camelot"]) > 0 and setbuilder._tempo_fit(by[a]["bpm"], by[b]["bpm"], 6) > 0
                 for a, b in zip(s, s[1:]))
        check(s[0] == ids["A minor 124"] and len(set(s)) == len(s) and ok, f"set builder makes a mixable run of {len(s)}: "
              + " > ".join(f"{by[i]['camelot']}@{by[i]['bpm']:.0f}" for i in s))
        check(ids["F# minor 140"] not in s, "set builder leaves out the track that won't mix")

        # duplicates: the same recording as WAV and as MP3 groups together, best copy first
        x, _ = structured(126, 0.25)
        wav = write(d / "dupe.wav", x)
        mp3 = d / "dupe.mp3"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-b:a", "192k", str(mp3)], check=True)
        for p in (wav, mp3):
            info = audio.probe(p)
            tid = lib.upsert(str(p), info)
            lib.save_analysis(tid, analyse_file(str(p), 88, -10, -1, info))
        from crate import fingerprint
        rows = lib.rows()
        for t in rows:
            t["issues"] = lib.issues(t)
        groups = fingerprint.duplicates(rows, lib.wave)
        paths = {t["id"]: t["path"] for t in rows}
        check(len(groups) == 1 and len(groups[0]["tracks"]) == 2 and paths[groups[0]["keep"]].endswith(".wav"),
              f"duplicate found, lossless copy kept {[[Path(paths[i]).name for i in g['tracks']] for g in groups]}")

        # play history: a stick whose history tables list two sessions
        tables = [Table(t) for t in range(20)]
        tables[0x0B].rows = [struct.pack("<I", 1) + dstr("HISTORY 001"), struct.pack("<I", 2) + dstr("HISTORY 002")]
        a, b, c = ids["A minor 124"], ids["E minor 125"], ids["C major 126"]
        tables[0x0C].rows = [struct.pack("<III", a, 1, 1), struct.pack("<III", b, 1, 2), struct.pack("<III", c, 2, 1),
                             struct.pack("<III", a, 2, 2)]
        stick = d / "stick" / "PIONEER" / "rekordbox"
        stick.mkdir(parents=True)
        (stick / "export.pdb").write_bytes(build(tables))
        sessions = pdbread.history(stick / "export.pdb")
        check(sessions == [{"name": "HISTORY 001", "tracks": [a, b]}, {"name": "HISTORY 002", "tracks": [c, a]}],
              f"history read off the stick {sessions}")
        jobs = Jobs(lib)
        res = jobs.harvest_history(d / "stick")
        again = jobs.harvest_history(d / "stick")
        plays = {t["id"]: t["plays"] for t in lib.rows()}
        check(res == {"sessions": 2, "plays": 4} and again["sessions"] == 0 and plays[a] == 2,
              f"history imported once, play counts updated {res} {again}")

        # wishlist and store links
        wid = lib.wish("Fisher", "Losing It")
        links = store.links("Fisher", "Losing It")
        check(lib.wishlist()[0]["id"] == wid and links["Beatport"].endswith("q=Fisher+Losing+It"), "wishlist and store search links")
        try:
            store.open_url("https://evil.example.com/x")
            check(False, "only store links open")
        except ValueError:
            check(True, "only store links open")
    print("all passed" if not fails else f"{len(fails)} failed")
    return len(fails)


if __name__ == "__main__":
    sys.exit(main())
