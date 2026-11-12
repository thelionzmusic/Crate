"""Read a player USB stick back: its database (export.pdb) and analysis files (ANLZ).

Used two ways: Check stick, which looks for anything a CDJ would trip over, and Import
from a rekordbox stick, which brings tracks, grids, cues and playlists into Crate.
Works on sticks written by Crate or by rekordbox.
"""
from __future__ import annotations

import os
import struct
import sys
from pathlib import Path

from .pdbread import _rows, _string

T_TRACKS, T_GENRES, T_ARTISTS, T_ALBUMS, T_KEYS, T_TREE, T_ENTRIES = 0, 1, 2, 3, 5, 7, 8
FILE_TYPES = {1: "mp3", 4: "m4a", 5: "flac", 11: "wav", 12: "aiff"}
# The order rekordbox writes tags in. A player stops reading at the first section it
# doesn't expect, so order matters as much as content.
ORDER = {".DAT": ["PPTH", "PVBR", "PQTZ", "PWAV", "PWV2", "PCOB", "PCOB"],
         ".EXT": ["PPTH", "PWV3", "PCOB", "PCOB", "PCO2", "PCO2", "PQT2", "PWV5", "PWV4", "PSSI"],
         ".2EX": ["PPTH", "PWV7", "PWV6", "PWVC"]}
NEEDED = {".DAT": {"PPTH", "PQTZ", "PWAV"}, ".EXT": {"PPTH", "PWV5", "PWV4"}, ".2EX": {"PPTH", "PWV7", "PWV6", "PWVC"}}


# ---- database ---------------------------------------------------------------------

def _track(d: bytes, p: int) -> dict:
    f = struct.unpack_from("<HHIIIIIHH" + "I" * 12 + "HHHHHHBBHH", d, p)
    s = [_string(d, p + o) for o in struct.unpack_from("<21H", d, p + 0x5E)]
    return {"id": f[20], "sample_rate": f[3], "file_size": f[5], "key_id": f[10], "bitrate": f[14],
            "bpm": f[16] / 100, "genre_id": f[17], "album_id": f[18], "artist_id": f[19], "year": f[23],
            "duration": f[25], "color": f[27], "rating": f[28] // 20 if f[28] > 5 else f[28], "file_type": f[29],
            "date_added": s[10], "analyze_path": s[14], "comment": s[16], "title": s[17], "filename": s[19],
            "file_path": s[20], "plays": f[22]}


def read_db(root: Path) -> dict:
    """Everything a stick's export.pdb says, as plain dicts. Raises ValueError if unreadable."""
    path = Path(root) / "PIONEER" / "rekordbox" / "export.pdb"
    try:
        d = path.read_bytes()
    except OSError:
        raise ValueError("There's no player library on this stick (PIONEER/rekordbox/export.pdb)") from None
    if len(d) < 4096 or struct.unpack_from("<I", d, 4)[0] != 4096:
        raise ValueError("The stick's library file is damaged or isn't a player library")
    u4 = lambda o: struct.unpack_from("<I", d, o)[0]  # noqa: E731
    names = lambda t, at: {u4(o + (4 if t == T_ARTISTS else 0)): _string(d, o + at(o)) for o in _rows(d, t)}  # noqa: E731
    tree, entries = [], {}
    for o in _rows(d, T_TREE):
        parent, _, sort, nid, folder = struct.unpack_from("<IIIII", d, o)
        tree.append({"id": nid, "parent": parent, "sort": sort, "folder": bool(folder), "name": _string(d, o + 20)})
    for o in _rows(d, T_ENTRIES):
        idx, track, pl = struct.unpack_from("<III", d, o)
        entries.setdefault(pl, []).append((idx, track))
    return {"tracks": [_track(d, o) for o in _rows(d, T_TRACKS)],
            "artists": names(T_ARTISTS, lambda o: d[o + 9]),
            "albums": {u4(o + 12): _string(d, o + d[o + 21]) for o in _rows(d, T_ALBUMS)},
            "genres": names(T_GENRES, lambda o: 4), "keys": names(T_KEYS, lambda o: 8),
            "tree": sorted(tree, key=lambda n: (n["parent"], n["sort"])),
            "entries": {pl: [t for _, t in sorted(v)] for pl, v in entries.items()}}


# ---- analysis files ---------------------------------------------------------------

def tags(data: bytes) -> list[tuple[str, bytes, bytes]]:
    """[(fourcc, head, body)] of an ANLZ file. Raises ValueError where a player would give up."""
    if data[:4] != b"PMAI" or len(data) < 28:
        raise ValueError("not an analysis file")
    lh, lf = struct.unpack_from(">II", data, 4)
    if lf != len(data):
        raise ValueError(f"says it is {lf} bytes long but is {len(data)}")
    out, pos = [], lh
    while pos < len(data):
        if pos + 12 > len(data):
            raise ValueError("ends partway through a section")
        h, ln = struct.unpack_from(">II", data, pos + 4)
        if h < 12 or ln < h or pos + ln > len(data):
            raise ValueError(f"section {data[pos:pos + 4]!r} has impossible lengths")
        out.append((data[pos:pos + 4].decode("ascii", "replace"), data[pos + 12:pos + h], data[pos + h:pos + ln]))
        pos += ln
    return out


def beats(body: bytes) -> list[tuple[int, float, int]]:
    """PQTZ body -> [(beat in bar, bpm, ms)]."""
    return [(b, t / 100, ms) for b, t, ms in struct.iter_unpack(">HHI", body)]


def cues(ext_or_dat: list[tuple[str, bytes, bytes]]) -> list[dict]:
    """Hot cues, memory cues and loops, with colours and names where the file has them
    (PCO2 in .EXT, else the plainer PCOB)."""
    out = {}
    for fourcc, head, body in ext_or_dat:
        if fourcc == "PCO2":
            pos = 0
            for _ in range(struct.unpack_from(">IH", head)[1]):
                ln = struct.unpack_from(">I", body, pos + 8)[0]
                hot, kind, t, loop = struct.unpack_from(">IB3xII", body, pos + 12)
                clen = struct.unpack_from(">I", body, pos + 40)[0]
                name = body[pos + 44:pos + 44 + clen].decode("utf-16-be", "ignore").rstrip("\0")
                rgb = body[pos + 45 + clen:pos + 48 + clen] if pos + 48 + clen <= pos + ln else b""
                colour = "#%02x%02x%02x" % tuple(rgb) if len(rgb) == 3 and any(rgb) else None
                out[(hot, t)] = {"slot": hot, "start_ms": t, "end_ms": loop if kind == 2 else -1, "name": name, "color": colour}
                pos += ln
    if out:  # PCO2 carries hot and memory cues with their colours; PCOB is only the fallback
        return sorted(out.values(), key=lambda c: (c["slot"] == 0, c["slot"], c["start_ms"]))
    for fourcc, head, body in ext_or_dat:
        if fourcc != "PCOB":
            continue
        pos = 0
        for _ in range(struct.unpack_from(">IHH", head)[2]):
            ln = struct.unpack_from(">I", body, pos + 8)[0]
            hot, kind = struct.unpack_from(">I", body, pos + 12)[0], body[pos + 28]
            t, loop = struct.unpack_from(">II", body, pos + 32)
            out[(hot, t)] = {"slot": hot, "start_ms": t, "end_ms": loop if kind == 2 else -1, "name": "", "color": None}
            pos += ln
    return sorted(out.values(), key=lambda c: (c["slot"] == 0, c["slot"], c["start_ms"]))


# ---- check ------------------------------------------------------------------------

def _filesystem(root: Path) -> str | None:
    if sys.platform == "win32":
        import ctypes
        buf = ctypes.create_unicode_buffer(32)
        drive = os.path.splitdrive(str(Path(root).resolve()))[0] + "\\"
        if ctypes.windll.kernel32.GetVolumeInformationW(drive, None, 0, None, None, None, buf, 32):
            return buf.value
        return None
    try:
        best = ("", None)
        for line in Path("/proc/mounts").read_text().splitlines():
            dev, mnt, fs, *_ = line.split()
            if str(Path(root).resolve()).startswith(mnt) and len(mnt) > len(best[0]):
                best = (mnt, fs)
        return best[1]
    except OSError:
        return None


def check(root: str | Path, progress=lambda *_: None) -> dict:
    """Everything on the stick a player would trip over.

    {ok, tracks, playlists, problems: [{level, title, issue}], filesystem}. level is
    "error" (a player won't load it or won't show it properly) or "warning"."""
    root = Path(root)
    problems: list[dict] = []
    add = lambda level, title, issue: problems.append({"level": level, "title": title, "issue": issue})  # noqa: E731
    fs = _filesystem(root)
    if fs and fs.lower() not in ("vfat", "fat32", "fat", "exfat", "msdos", "fuseblk"):
        add("error", "Stick", f"It's formatted {fs}. CDJs only read FAT32 or exFAT: reformat it as exFAT")
    if any((root / "PIONEER" / "rekordbox").glob("exportLibrary.db*")):
        add("warning", "Stick", "rekordbox's newer library (exportLibrary.db) is on here. CDJ-3000s read it instead of "
            "this export: export from Crate again and it's moved aside")
    db = read_db(root)
    known = {t["id"] for t in db["tracks"]}
    for i, t in enumerate(db["tracks"]):
        if i % 25 == 0:
            progress(f"Checking {i + 1}/{len(db['tracks'])}", i / max(1, len(db["tracks"])))
        title, rel = t["title"] or t["filename"], t["file_path"].lstrip("/")
        f = root / rel
        if not f.is_file():
            add("error", title, f"The audio file is missing ({t['file_path']})")
            continue
        size = f.stat().st_size
        if t["file_size"] and size != t["file_size"]:
            add("warning", title, "The audio file changed since the library was written. Export again")
        if len(t["file_path"]) > 255:
            add("error", title, "Its path on the stick is too long for players")
        if FILE_TYPES.get(t["file_type"]) is None:
            add("warning", title, "The library doesn't say what format it is, so older players may skip it")
        if not t["analyze_path"]:
            add("error", title, "No analysis files: no waveform, beat grid or cues on the player")
            continue
        base = root / t["analyze_path"].lstrip("/")
        for ext in (".DAT", ".EXT", ".2EX"):
            af = base.with_suffix(ext)
            what = {".DAT": "beat grid and overview", ".EXT": "colour waveform and cues", ".2EX": "CDJ-3000 3-band waveform"}[ext]
            if not af.is_file():
                add("error" if ext != ".2EX" else "warning", title, f"Analysis file {af.name} is missing: no {what}")
                continue
            try:
                found = tags(af.read_bytes())
            except ValueError as e:
                add("error", title, f"{af.name} is damaged ({e}): no {what}")
                continue
            names = [n for n, *_ in found]
            missing = NEEDED[ext] - set(names)
            if missing:
                add("error", title, f"{af.name} lacks {', '.join(sorted(missing))}: no {what}")
            order = [n for n in ORDER[ext] if n in names]
            seen = [n for n in names if n in ORDER[ext]]
            if seen != order[:len(seen)] and seen != sorted(seen, key=ORDER[ext].index):
                add("error", title, f"{af.name} has its sections out of order, so players stop reading it early")
            byname = {n: (h, b) for n, h, b in found}
            if "PPTH" in byname:
                ln = struct.unpack_from(">I", byname["PPTH"][0])[0]
                path = byname["PPTH"][1][:ln].decode("utf-16-be", "ignore").rstrip("\0")
                if path != t["file_path"]:
                    add("error", title, f"{af.name} belongs to a different file ({path})")
            if ext == ".DAT":
                if "PQTZ" in byname and not byname["PQTZ"][1]:
                    add("warning", title, "It has no beat grid, so sync and quantise won't work")
                if FILE_TYPES.get(t["file_type"]) == "mp3" and "PVBR" in byname and not struct.unpack_from(">I", byname["PVBR"][1], 1600)[0]:
                    add("warning", title, "Its analysis doesn't give the track length, so it may load slowly and show no "
                        "waveform. Export it again from Crate 1.12.2 or later")
    for pl, ids in db["entries"].items():
        if any(i not in known for i in ids):
            add("warning", "Playlists", "A playlist points at tracks that aren't on the stick")
            break
    progress("Done", 1.0)
    errors = sum(p["level"] == "error" for p in problems)
    return {"ok": not errors, "tracks": len(db["tracks"]), "playlists": sum(not n["folder"] for n in db["tree"]),
            "filesystem": fs, "errors": errors, "warnings": len(problems) - errors, "problems": problems[:500]}
