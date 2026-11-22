"""Write a Pioneer-ready USB: /Contents audio, /PIONEER/USBANLZ analysis, export.pdb."""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import string
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .. import audio
from ..analysis import tempo
from ..cancel import Cancel, Cancelled
from . import anlz, level, pdb, stick

MANIFEST = "PIONEER/.crate.json"  # what Crate put on the stick: copies, and the playlist tree


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
        system = os.environ.get("SYSTEMDRIVE", "C:").upper()  # Windows environment names ignore case
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
                # a Mac lists its own disk in /Volumes too (a link to /): never offer that
                out += [{"path": str(p), "label": p.name, "fs": ""} for p in base.iterdir() if p.is_dir() and p.resolve() != Path("/")]
    for d in out:
        try:
            u = shutil.disk_usage(d["path"])
            d["free_gb"], d["total_gb"] = round(u.free / 1e9, 1), round(u.total / 1e9, 1)
        except OSError:
            d["free_gb"] = d["total_gb"] = 0
    return out


def manifest(root: Path) -> dict:
    """The stick's manifest: {"tracks": {id: copy record}, "playlists": [...] | None, "extra": [...]}.
    Versions before 1.17 kept only the copies, so their playlists are unknown (None)."""
    try:
        m = json.loads((Path(root) / MANIFEST).read_text("utf-8"))
    except (OSError, ValueError):
        return {"tracks": {}, "playlists": None, "extra": []}
    return m if m.get("v") == 2 else {"tracks": m, "playlists": None, "extra": []}


def layout(root: Path) -> dict | None:
    """What Crate last put on the stick, as playlists of Crate track ids plus tracks on it outside
    any playlist; None if Crate didn't write the stick's current library (rekordbox did, or
    it's changed since), in which case an export replaces it rather than adding to it."""
    root = Path(root)
    m = manifest(root)
    db = root / "PIONEER" / "rekordbox"
    if m["playlists"] is None or any(db.glob("exportLibrary.db*")):
        return None
    try:
        on_stick = {t["id"] for t in stick.read_db(root)["tracks"]}
    except ValueError:
        return None
    return m if on_stick == {int(i) for i in m["tracks"]} else None


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


COPY_RATE = 20e6     # bytes a second to a typical USB stick
ANLZ_SECONDS = 0.04  # writing one track's analysis


def estimate(root: Path, tracks: list[dict], profile_key: str) -> dict:
    """What an export would put on the stick: tracks new to it, the bytes they take, roughly how
    long it takes, and whether it fits in the space left (counting what it frees)."""
    profile = PROFILES.get(profile_key, PROFILES["cdj3000"])
    have = manifest(Path(root))["tracks"]
    new_bytes = 0
    new = [t for t in tracks if str(t["id"]) not in have]
    for t in new:
        out, _, rate, bits = plan(t, profile)
        if out != level.container_of(Path(t["path"]), t["codec"]) or rate:
            new_bytes += int((t["duration"] or 0) * (rate or t["sample_rate"]) * bits // 8 * 2)
        else:
            try:
                new_bytes += os.stat(t["path"]).st_size
            except OSError:
                pass
    keep = {t["id"] for t in tracks}
    freed = 0
    for i, rec in have.items():
        if int(i) not in keep:
            try:
                freed += (Path(root) / rec["dest"].lstrip("/")).stat().st_size
            except OSError:
                pass
    free = shutil.disk_usage(root).free
    return {"tracks": len(tracks), "new": len(new), "bytes": new_bytes, "free": free, "fits": new_bytes <= free + freed,
            "seconds": round(new_bytes / COPY_RATE + len(tracks) * ANLZ_SECONDS)}


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


def export(root: Path, tracks: list[dict], nodes: list[pdb.Node], cues: dict[int, list[anlz.Cue]],
           wave: Callable[[int], np.ndarray], opts: Options,
           progress: Callable[[str, float], None] = lambda *_: None,
           cancel: Cancel | None = None) -> dict:
    """Export `tracks` and the playlist tree `nodes` to the drive at `root`.

    It can be stopped while copying audio, which leaves the stick's library as it was; what was
    already copied is noted, so the next export carries on from there. Once the analysis and
    database are being rewritten it always finishes, so a stick is never left half-written."""
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
    old = manifest(root)["tracks"]

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
            if cancel and cancel.asked:  # stop queued copies; the ones under way finish cleanly
                progress("Stopping", 0.05 + 0.75 * done / max(1, len(todo)))
                for other in futures:
                    other.cancel()
                break
    for f, j in futures.items():  # copies that finished while stopping
        if j.id not in applied and f.done() and not f.cancelled() and not f.exception():
            applied[j.id] = f.result()[1]

    try:
        if cancel:
            cancel.commit()
    except Cancelled:
        copied = {j.id: j for j in todo if j.id in applied}
        manifest_path.write_text(json.dumps({**old, **{str(i): {"dest": j.dest, "sig": j.sig, "applied": applied[i]} for i, j in copied.items()}}), "utf-8")  # v1: copies only, playlists unknown
        raise Cancelled({"copied": len(copied), "of": len(todo)}) from None

    ok_jobs = [j for j in jobs if j.id in applied]
    warnings += [f"{j.track['title']}: AAC can't be gain-changed losslessly; trim it by {j.gain:+.1f} dB."
                 for j in ok_jobs if j.container == "aac" and abs(j.gain - applied[j.id]) >= 1.0]

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
    # Every track's analysis is written fresh into a staging folder and swapped in with the
    # database at the end, so an export that fails part way leaves the stick's previous library
    # whole. Starting clean also drops files in folders players don't look in.
    staged = pioneer / "USBANLZ.new"
    shutil.rmtree(staged, ignore_errors=True)
    taken: dict[str, int] = {}  # analysis folder -> files in it: two paths can share a folder
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

        where = anlz.folder(name)
        slot = taken[where] = taken.get(where, -1) + 1  # sharing a folder: ANLZ0001, as rekordbox does
        anlz_rel = f"{where}/ANLZ{slot:04d}"
        beats = t.get("grid") or tempo.grid(t["bpm"] or 0.0, t["first_beat_ms"] or 0.0, t["downbeat"] or 0, t["duration"])
        vbr = level.mp3_vbr(dest.read_bytes()) if j.container == "mp3" else None
        dat, ext, ex2 = anlz.build(name, beats, t["bpm"] or 0.0, wave(tid), cues.get(tid, []), vbr,
                                   json.loads(t["tempos"]) if t.get("tempos") else None)
        a_dir = staged / where.removeprefix("/PIONEER/USBANLZ/")
        a_dir.mkdir(parents=True, exist_ok=True)
        for suffix, blob in ((".DAT", dat), (".EXT", ext), (".2EX", ex2)):
            (a_dir / f"ANLZ{slot:04d}{suffix}").write_bytes(blob)

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
    db = pdb.export_pdb(rows, artists, albums, genres, labels, keys, artwork, nodes)
    lib_dir = pioneer / "rekordbox"
    lib_dir.mkdir(parents=True, exist_ok=True)
    (lib_dir / "export.pdb.new").write_bytes(db)
    (lib_dir / "exportExt.pdb.new").write_bytes(pdb.export_ext_pdb())
    # the swap: a few renames, so the library is never half old and half new for long
    staged.mkdir(exist_ok=True)
    if (pioneer / "USBANLZ").exists():
        shutil.rmtree(pioneer / "USBANLZ.old", ignore_errors=True)
        (pioneer / "USBANLZ").rename(pioneer / "USBANLZ.old")
    staged.rename(pioneer / "USBANLZ")
    os.replace(lib_dir / "export.pdb.new", lib_dir / "export.pdb")
    os.replace(lib_dir / "exportExt.pdb.new", lib_dir / "exportExt.pdb")
    shutil.rmtree(pioneer / "USBANLZ.old", ignore_errors=True)
    # Player settings files rekordbox puts on every stick; keep any the stick already has.
    for f in (Path(__file__).with_name("templates")).glob("*SETTING*.DAT"):
        if not (pioneer / f.name).exists():
            (pioneer / f.name).write_bytes(f.read_bytes())

    # Remove files from earlier exports that are no longer on the stick's playlists.
    keep = {r.file_path for r in rows}
    for rec in old.values():
        if rec.get("dest") not in keep:
            gone = root / rec["dest"].lstrip("/")
            gone.unlink(missing_ok=True)
            for folder in (gone.parent, gone.parent.parent):  # album, then artist, once empty
                try:
                    folder.rmdir()
                except OSError:
                    break
    in_lists = {i for n in nodes for i in n.track_ids}
    before, after = {int(i) for i in old}, {r.id for r in rows}
    manifest_path.write_text(json.dumps({
        "v": 2, "tracks": {str(j.id): {"dest": j.dest, "sig": j.sig, "applied": applied[j.id]} for j in ok_jobs},
        "playlists": [{"id": n.id, "name": n.name, "parent": n.parent_id, "folder": n.is_folder, "sort": n.sort, "tracks": n.track_ids}
                      for n in nodes],
        "extra": [r.id for r in rows if r.id not in in_lists]}), "utf-8")
    progress("Done", 1.0)
    return {"tracks": len(rows), "copied": len(fresh & set(applied)), "added": len(after - before),
            "removed": len(before - after), "updated": len(after & before & fresh),
            "playlists": sum(1 for n in nodes if not n.is_folder), "warnings": warnings}


def walk(nodes: Iterable[pdb.Node]) -> list[int]:
    seen, out = set(), []
    for n in nodes:
        for i in n.track_ids:
            if i not in seen:
                seen.add(i)
                out.append(i)
    return out
