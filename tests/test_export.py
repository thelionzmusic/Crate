"""End-to-end: analyse synthetic tracks, export a USB tree, read it back independently."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from pdbreader import anlz_beats, anlz_cues, anlz_path, read_anlz, read_pdb  # noqa: E402
from synth import SR, track  # noqa: E402

from crate import audio  # noqa: E402
from crate.analysis import analyse_file  # noqa: E402
from crate.analysis.loudness import integrated_lufs, true_peak_db  # noqa: E402
from crate.export import anlz, pdb, usb  # noqa: E402

TARGET, CEILING = -10.0, -1.0


def rekordbox_layout(d: bytes) -> list[str]:
    """Conventions observed in a genuine rekordbox 7 export.pdb. Returns violations."""
    import struct
    bad = []
    n_tables = struct.unpack_from("<I", d, 8)[0]
    for i in range(n_tables):
        ttype, empty, first, last = struct.unpack_from("<IIII", d, 0x1C + 16 * i)
        b = first * 4096
        if d[b + 0x1B] != 0x64:
            bad.append(f"t{ttype} first page not an index page")
        if d[b + 0x20:b + 0x26] != bytes.fromhex("ff1fff1fec03"):
            bad.append(f"t{ttype} index header not at 0x20")
        if struct.unpack_from("<I", d, b + 0x28)[0] != first or d[b + 0x3C:b + 0x40] != bytes.fromhex("f8ffff1f"):
            bad.append(f"t{ttype} index body")
        if d[b + 4096 - 20:b + 4096] != bytes(20):
            bad.append(f"t{ttype} index tail")
        if empty * 4096 < len(d) and any(d[empty * 4096:(empty + 1) * 4096]):
            bad.append(f"t{ttype} spare page not blank")
    colors = d.find(bytes.fromhex("00000000010100000b50696e6b"))
    if colors < 0:
        bad.append("colour rows")
    return bad


def make(d: Path):
    specs = [  # name, codec args, ext, bpm, gain
        ("Quiet Dub", ["-c:a", "pcm_s16le"], "wav", 122.0, -16.0),
        ("Loud Banger", ["-c:a", "libmp3lame", "-b:a", "320k"], "mp3", 128.0, 0.0),
        ("Hi-Res Roller", ["-c:a", "flac", "-sample_fmt", "s32", "-ar", "96000"], "flac", 174.0, -6.0),
        ("Ünïcödé Träck — 夜", ["-c:a", "pcm_s24be"], "aiff", 126.0, -9.0),
        ("Medium MP3", ["-c:a", "libmp3lame", "-b:a", "256k"], "mp3", 124.0, -12.0),
    ]
    out = []
    for i, (name, args, ext, bpm, g) in enumerate(specs):
        x = track(bpm, 0.1 + 0.05 * i, "A", True, seconds=45, gain_db=g, seed=i)
        p = d / f"{name}.{ext}"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                        "-metadata", f"title={name}", "-metadata", f"artist=Artist {i % 2}",
                        "-metadata", "album=Album", "-metadata", "genre=House", *args, str(p)],
                       input=x.tobytes(), check=True)
        out.append(p)
    return out


def main():
    fails = []

    def check(cond, msg):
        print(("PASS " if cond else "FAIL ") + msg)
        if not cond:
            fails.append(msg)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        lib = tmp / "lib"
        lib.mkdir()
        usb_root = tmp / "usb"
        usb_root.mkdir()
        tracks, waves = [], {}
        for i, p in enumerate(make(lib), 1):
            info = audio.probe(p)
            r = analyse_file(str(p), 88.0, TARGET, CEILING)
            assert r["ok"], r
            waves[i] = np.frombuffer(r["wave"], np.uint8).reshape(-1, 3)
            tracks.append({**info, "id": i, "path": str(p), "bpm": r["bpm"], "first_beat_ms": r["first_beat_ms"],
                           "downbeat": r["downbeat"], "key": r["key"], "gain_db": r["gain_db"],
                           "rating": 3, "color": 0, "date_added": "2026-11-05", "plays": 0})
            print(f"  {p.name:28} {info['codec']:5} {info['sample_rate']} {info['bit_depth']}b  "
                  f"lufs {r['lufs']:6.2f} tp {r['true_peak']:5.2f} gain {r['gain_db']:+.2f}")
        nodes = [pdb.Node(1, "Gigs", is_folder=True, sort=0),
                 pdb.Node(2, "St Andrews", parent_id=1, sort=0, track_ids=[1, 2, 3, 4, 5]),
                 pdb.Node(3, "Warm Up", parent_id=1, sort=1, track_ids=[4, 1]),
                 pdb.Node(4, "Bangers", sort=1, track_ids=[2])]
        cues = {2: [anlz.Cue(1, 1000), anlz.Cue(2, 5000, 8000, (255, 0, 0), "Drop"), anlz.Cue(0, 500)]}

        for profile in ("cdj3000", "universal"):
            res = usb.export(usb_root, tracks, [pdb.Node(**{**n.__dict__, "track_ids": list(n.track_ids)}) for n in nodes],
                             cues, waves.__getitem__, usb.Options(profile=profile))
            print(f"  export[{profile}]: {res}")
            data = (usb_root / "PIONEER/rekordbox/export.pdb").read_bytes()
            t = read_pdb(data)
            check(len(t[0]) == 5, f"[{profile}] 5 track rows")
            check([n["name"] for n in t[7]] == ["Gigs", "St Andrews", "Warm Up", "Bangers"], f"[{profile}] playlist tree")
            entries = [(e["playlist"], e["entry"], e["track"]) for e in t[8]]
            check(entries == [(2, 1, 1), (2, 2, 2), (2, 3, 3), (2, 4, 4), (2, 5, 5), (3, 1, 4), (3, 2, 1), (4, 1, 2)],
                  f"[{profile}] playlist entries in order")
            check(len(t[16]) == 27 and len(t[17]) == 22 and len(t[18]) == 17 and len(t[19]) == 1,
                  f"[{profile}] menu/columns/sort/history tables")
            check(rekordbox_layout(data) == [], f"[{profile}] page layout matches rekordbox: {rekordbox_layout(data)[:3]}")
            types = {r["file_path"].rsplit(".", 1)[1]: r["file_type"] for r in t[0]}
            check(types.get("mp3") == 1 and types.get("wav", 11) == 11 and types.get("aiff", 12) == 12,
                  f"[{profile}] file type codes {types}")
            check(t[3][0]["name"] == "Album" and len(t[2]) == 2, f"[{profile}] artists/albums")
            uni = [r for r in t[0] if r["title"].startswith("Ü")]
            check(bool(uni) and uni[0]["file_path"].endswith(".aiff"), f"[{profile}] unicode title round-trips")

            for row in t[0]:
                f = usb_root / row["file_path"].lstrip("/")
                check(f.is_file() and f.stat().st_size == row["file_size"], f"[{profile}] {row['filename']} present, size matches")
                tr = tracks[row["id"] - 1]
                dat = read_anlz((usb_root / row["analyze_path"].lstrip("/")).read_bytes())
                ext = read_anlz((usb_root / row["analyze_path"].lstrip("/")).with_suffix(".EXT").read_bytes())
                ex2 = read_anlz((usb_root / row["analyze_path"].lstrip("/")).with_suffix(".2EX").read_bytes())
                check(anlz_path(dat["PPTH"][0]) == row["file_path"], f"[{profile}] {row['id']} ANLZ path")
                beats = anlz_beats(dat["PQTZ"][0])
                check(len(beats) > 60 and beats[0][1] == row["tempo"] and abs(beats[1][2] - beats[0][2] - 60000 / tr["bpm"]) < 1.01,
                      f"[{profile}] {row['id']} beatgrid ({len(beats)} beats @ {row['tempo'] / 100})")
                check({"PWV3", "PWV4", "PWV5"} <= set(ext) and {"PWV6", "PWV7"} <= set(ex2), f"[{profile}] {row['id']} waveforms")
                if row["id"] == 2:
                    _, hot = anlz_cues(dat["PCOB"][0])
                    _, mem = anlz_cues(dat["PCOB"][1])
                    check(hot == [(1, 1, 1000, 0xFFFFFFFF), (2, 2, 5000, 8000)] and mem[0][2] == 500, f"[{profile}] cues")

                # levelling: measured loudness/peak of the exported file
                if profile == "cdj3000":
                    y = audio.decode(f, 44100)
                    lufs, tp = integrated_lufs(y, 44100), true_peak_db(y)
                    expect = min(TARGET, tr.get("lufs_src", TARGET))
                    print(f"      {row['filename']:30} -> {lufs:6.2f} LUFS  {tp:5.2f} dBTP  ({row['sample_rate']}/{row['depth']}b)")
                    check(tp <= CEILING + 0.3, f"{row['filename']} no overs after levelling")
                    tr.setdefault("out_lufs", lufs)
            if profile == "universal":
                check(not any(r["file_path"].endswith(".flac") for r in t[0]), "[universal] FLAC converted to AIFF")
                check(all(r["sample_rate"] <= 48000 for r in t[0]), "[universal] rates within 48 kHz")

        man = json.loads((usb_root / "PIONEER/.crate.json").read_text())
        res = usb.export(usb_root, tracks, nodes, cues, waves.__getitem__, usb.Options(profile="universal"))
        check(res["copied"] == 0, f"re-export is incremental (copied {res['copied']}, manifest {len(man)})")
        loud = [tr["out_lufs"] for tr in tracks]
        print(f"  output loudness spread {min(loud):.2f} .. {max(loud):.2f} LUFS")

    print("all passed" if not fails else f"{len(fails)} failed")
    return len(fails)


if __name__ == "__main__":
    sys.exit(main())
