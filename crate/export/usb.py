"""Write a Pioneer-ready USB: /Contents audio, /PIONEER/USBANLZ analysis, export.pdb."""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import string
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import numpy as np

from .. import audio
from ..analysis import tempo
from . import anlz, level, pdb

MANIFEST = "PIONEER/.crate.json"


@dataclass(frozen=True)
class Profile:
    key: str
    label: str
    lossless: frozenset[str]  # lossless containers beyond WAV/AIFF the players read
    max_rate: int
    filesystems: frozenset[str]


PROFILES = {p.key: p for p in [
    Profile("cdj3000", "CDJ-3000, CDJ-3000X, XDJ-AZ, OPUS-QUAD, OMNIS-DUO",
            frozenset({"flac", "alac"}), 96000, frozenset({"FAT32", "exFAT", "HFS+"})),
    Profile("nxs2", "CDJ-2000NXS2, CDJ-TOUR1, XDJ-1000MK2, XDJ-RX2, XDJ-RX3, XDJ-XZ, XDJ-RR, DJS-1000",
            frozenset({"flac", "alac"}), 96000, frozenset({"FAT32", "HFS+"})),
    Profile("universal", "Any Pioneer player, including CDJ-2000NXS, CDJ-900NXS, CDJ-2000, CDJ-900, XDJ-1000, XDJ-700, XDJ-RX",
            frozenset(), 48000, frozenset({"FAT32"})),
]}

_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe(name: str, fallback: str) -> str:
    name = _BAD.sub("_", name).strip().rstrip(". ")
    return (name or fallback)[:96]


def fs_type(root: Path) -> str:
    if os.name != "nt":
        return ""
    import ctypes
    buf = ctypes.create_unicode_buffer(64)
    ok = ctypes.windll.kernel32.GetVolumeInformationW(str(root.anchor), None, 0, None, None, None, buf, 64)
    return buf.value if ok else ""


def drives() -> list[dict]:
    """Candidate export targets (anything mounted that isn't the system drive)."""
    out = []
    if os.name == "nt":
        import ctypes
        mask = ctypes.windll.kernel32.GetLogicalDrives()
        system = os.environ.get("SystemDrive", "C:").upper()
        for i, letter in enumerate(string.ascii_uppercase):
            root = f"{letter}:\\"
            if not mask >> i & 1 or f"{letter}:" == system:
                continue
            if ctypes.windll.kernel32.GetDriveTypeW(root) not in (2, 3):  # removable, fixed
                continue
            label = ctypes.create_unicode_buffer(64)
            ctypes.windll.kernel32.GetVolumeInformationW(root, label, 64, None, None, None, None, 0)
            out.append({"path": root, "label": label.value or f"{letter}:", "fs": fs_type(Path(root))})
    else:
        for base in (Path("/Volumes"), Path("/media") / os.environ.get("USER", ""), Path("/mnt")):
            if base.is_dir():
                out += [{"path": str(p), "label": p.name, "fs": ""} for p in base.iterdir() if p.is_dir()]
    for d in out:
        try:
            u = shutil.disk_usage(d["path"])
            d["free_gb"], d["total_gb"] = round(u.free / 1e9, 1), round(u.total / 1e9, 1)
        except OSError:
            d["free_gb"] = d["total_gb"] = 0
    return out


def plan(track: dict, profile: Profile) -> tuple[str, str, int | None, int]:
    """(output container, extension, new sample rate or None, bit depth) for this player family."""
    src = Path(track["path"])
    c = level.container_of(src, track["codec"])
    bits = 16 if c in ("mp3", "aac") else min(max(track["bit_depth"], 16), 24)
    rate = None
    if track["sample_rate"] > profile.max_rate:
        rate = 48000 if track["sample_rate"] % 48000 == 0 and profile.max_rate >= 48000 else 44100
        if profile.max_rate >= 96000 and track["sample_rate"] % 48000 == 0:
            rate = 96000
        if profile.max_rate >= 88200 and track["sample_rate"] % 44100 == 0:
            rate = 88200
    out = c
    if c in ("flac", "alac") and c not in profile.lossless:
        out = "aiff"
    if c in ("mp3", "aac") and rate:
        out, bits = "aiff", 16  # lossy files above the limit don't exist in practice
    ext = {"mp3": ".mp3", "aiff": ".aiff", "wav": ".wav", "flac": ".flac", "alac": ".m4a", "aac": src.suffix.lower()}[out]
    return out, ext, rate, bits


@dataclass
class Job:
    track: dict
    dest: str        # device path, /Contents/...
    container: str
    rate: int | None
    bits: int
    gain: float
    sig: list

    @property
    def id(self) -> int:
        return self.track["id"]


@dataclass
class Options:
    profile: str = "cdj3000"
    level: bool = True
    menu_tables: bool = True  # turn off to A/B-test an older player that dislikes them
    phrases: bool = False     # experimental: write phrase lanes for CDJ-3000


def export(root: Path, tracks: list[dict], nodes: list[pdb.Node], cues: dict[int, list[anlz.Cue]],
           wave: Callable[[int], np.ndarray], opts: Options,
           progress: Callable[[str, float], None] = lambda *_: None,
           phrases: dict[int, list[dict]] | None = None) -> dict:
    """Export `tracks` and the playlist tree `nodes` to the drive at `root`."""
    profile = PROFILES[opts.profile]
    root = Path(root)
    pioneer = root / "PIONEER"
    (pioneer / "rekordbox").mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []
    fs = fs_type(root)
    if fs and fs not in profile.filesystems:
        warnings.append(f"Drive is {fs}; {profile.label.split(', ')[0]} players need "
                        f"{' or '.join(sorted(profile.filesystems))}. Reformat the stick if it won't mount.")

    manifest_path = root / MANIFEST
    try:
        old = json.loads(manifest_path.read_text("utf-8"))
    except (OSError, ValueError):
        old = {}

    # ---- destination names ------------------------------------------------
    used: set[str] = set()
    jobs = []
    for t in tracks:
        out_c, ext, rate, bits = plan(t, profile)
        folder = f"/Contents/{_safe(t['artist'], 'Unknown Artist')}/{_safe(t['album'], 'Unknown Album')}"
        stem = _safe(Path(t["path"]).stem, f"track {t['id']}")
        name, n = f"{folder}/{stem}{ext}", 2
        while name.lower() in used:
            name, n = f"{folder}/{stem} ({n}){ext}", n + 1
        used.add(name.lower())
        gain = t["gain_db"] if opts.level and t["gain_db"] is not None else 0.0
        jobs.append(Job(t, name, out_c, rate, bits, gain, [t["size"], t["mtime"], round(gain, 2), out_c, rate, bits]))

    # ---- audio --------------------------------------------------------------
    applied: dict[int, float] = {}
    todo = []
    for j in jobs:
        prev = old.get(str(j.id), {})
        if prev.get("sig") == j.sig and prev.get("dest") == j.dest and (root / j.dest.lstrip("/")).is_file():
            applied[j.id] = prev["applied"]
        else:
            todo.append(j)
    fresh = {j.id for j in todo}

    def copy(j: Job):
        t = j.track
        room = (t["ceiling"] - t["true_peak"]) if t.get("true_peak") is not None else None
        return j.id, level.render(Path(t["path"]), root / j.dest.lstrip("/"), j.gain, t["codec"], j.bits,
                                  j.container, j.rate, room)

    done = 0
    with ThreadPoolExecutor(max_workers=min(8, (os.cpu_count() or 4))) as pool:
        futures = {pool.submit(copy, j): j for j in todo}
        for f in as_completed(futures):
            j = futures[f]
            try:
                tid, a = f.result()
                applied[tid] = a
            except Exception as e:  # keep going; report the casualty
                warnings.append(f"Skipped {Path(j.track['path']).name}: {e}")
            done += 1
            progress(f"Copying {done}/{len(todo)}", 0.05 + 0.75 * done / max(1, len(todo)))

    ok_jobs = [j for j in jobs if j.id in applied]
    for j in ok_jobs:
        if j.container == "aac" and abs(j.gain - applied[j.id]) >= 1.0:
            warnings.append(f"{j.track['title']}: AAC can't be gain-changed losslessly; trim it by {j.gain:+.1f} dB.")

    # ---- lookup tables ------------------------------------------------------
    artists, albums, genres, labels, keys, artwork = {}, {}, {}, {}, {}, {}

    def ref(table: dict, k):
        if not k:
            return 0
        return table.setdefault(k, len(table) + 1)

    art_dir = pioneer / "Artwork" / "00001"
    today = dt.date.today().isoformat()
    rows: list[pdb.TrackRow] = []
    progress("Writing analysis", 0.82)
    for k, j in enumerate(ok_jobs):
        t, tid, name = j.track, j.id, j.dest
        dest = root / name.lstrip("/")
        aid = ref(artists, t["artist"])
        art_id = 0
        if t["has_art"]:
            art_dir.mkdir(parents=True, exist_ok=True)
            rel = f"/PIONEER/Artwork/00001/a{tid}.jpg"
            big, small = art_dir / f"a{tid}_m.jpg", art_dir / f"a{tid}.jpg"
            if (small.is_file() and big.is_file() and tid not in fresh) or \
                    (audio.extract_art(t["path"], small, 80) and audio.extract_art(t["path"], big, 240)):
                art_id = ref(artwork, rel)

        crc = zlib.crc32(name.encode("utf-8"))
        anlz_rel = f"/PIONEER/USBANLZ/P{crc >> 20 & 0xFFF:03X}/{crc:08X}/ANLZ0000"
        beats = t.get("grid") or tempo.grid(t["bpm"] or 0.0, t["first_beat_ms"] or 0.0, t["downbeat"] or 0, t["duration"])
        vbr = level.mp3_vbr_index(dest.read_bytes()) if j.container == "mp3" else None
        dat, ext, ex2 = anlz.build(name, beats, t["bpm"] or 0.0, wave(tid), cues.get(tid, []), vbr,
                                   (phrases or {}).get(tid) if opts.phrases else None, t["first_beat_ms"] or 0.0)
        a_dir = root / anlz_rel.lstrip("/").rsplit("/", 1)[0]
        a_dir.mkdir(parents=True, exist_ok=True)
        for suffix, blob in ((".DAT", dat), (".EXT", ext), (".2EX", ex2)):
            (a_dir / f"ANLZ0000{suffix}").write_bytes(blob)

        rows.append(pdb.TrackRow(
            id=tid, title=t["title"], file_path=name, analyze_path=anlz_rel + ".DAT",
            sample_rate=j.rate or t["sample_rate"], file_size=dest.stat().st_size,
            bitrate=t["bitrate"] if j.container == level.container_of(Path(t["path"]), t["codec"]) and not j.rate
            else (j.rate or t["sample_rate"]) * j.bits * 2 // 1000, tempo_x100=int(round((t["bpm"] or 0) * 100)),
            duration_s=int(round(t["duration"])), sample_depth=j.bits,
            artist_id=aid, album_id=ref(albums, (t["album"], aid)) if t["album"] else 0,
            genre_id=ref(genres, t["genre"]), label_id=ref(labels, t["label"]),
            remixer_id=ref(artists, t["remixer"]), key_id=ref(keys, t.get("camelot") or t["key"]), artwork_id=art_id,
            file_type=pdb.FILE_TYPES.get(j.container, 1),
            color_id=t["color"] or 0, rating=t["rating"] or 0,
            year=t["year"] or 0, track_number=t["track_no"] or 0, play_count=t["plays"] or 0,
            comment=t["comment"] or "", date_added=t["date_added"] or today, analyze_date=today))
        if k % 25 == 0:
            progress(f"Writing analysis {k}/{len(ok_jobs)}", 0.82 + 0.15 * k / max(1, len(ok_jobs)))

    exported = {r.id for r in rows}
    for n in nodes:
        n.track_ids = [i for i in n.track_ids if i in exported]

    progress("Writing database", 0.98)
    # A stick rekordbox has also written to carries its newer library (exportLibrary.db),
    # which rekordbox 7 and CDJ-3000 firmware 3+ read in preference to export.pdb. Left in
    # place it would hide this export, so move it aside rather than delete it.
    stale = [f for f in (pioneer / "rekordbox").glob("exportLibrary.db*") if f.is_file()]
    if stale:
        backup = pioneer / "rekordbox" / f"rekordbox-backup-{dt.datetime.now():%Y%m%d-%H%M%S}"
        backup.mkdir()
        for f in stale:
            f.replace(backup / f.name)
        warnings.append(f"Moved rekordbox's own device library aside to {backup.relative_to(root)} so players read this export.")
    db = pdb.export_pdb(rows, artists, albums, genres, labels, keys, artwork, nodes, opts.menu_tables)
    (pioneer / "rekordbox" / "export.pdb").write_bytes(db)
    (pioneer / "rekordbox" / "exportExt.pdb").write_bytes(pdb.export_ext_pdb())
    # Player settings files rekordbox puts on every stick; keep any the stick already has.
    for f in (Path(__file__).with_name("templates")).glob("*SETTING*.DAT"):
        if not (pioneer / f.name).exists():
            (pioneer / f.name).write_bytes(f.read_bytes())

    # Remove files from earlier exports that are no longer on the stick's playlists.
    keep = {r.file_path for r in rows}
    for tid, rec in old.items():
        if rec.get("dest") not in keep:
            (root / rec["dest"].lstrip("/")).unlink(missing_ok=True)
    manifest = {str(j.id): {"dest": j.dest, "sig": j.sig, "applied": applied[j.id]} for j in ok_jobs}
    manifest_path.write_text(json.dumps(manifest), "utf-8")
    progress("Done", 1.0)
    return {"tracks": len(rows), "copied": len(fresh & set(applied)),
            "playlists": sum(1 for n in nodes if not n.is_folder), "warnings": warnings}


def walk(nodes: Iterable[pdb.Node]) -> list[int]:
    seen, out = set(), []
    for n in nodes:
        for i in n.track_ids:
            if i not in seen:
                seen.add(i)
                out.append(i)
    return out
