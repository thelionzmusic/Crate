"""Import a rekordbox USB stick: tracks, beat grids, cues and playlists, as rekordbox left them.

For DJs moving over without a rekordbox.xml: plug in the stick you already gig with.
Tracks you already have in Crate (same file name and size) are matched rather than copied;
the rest are copied off the stick into a folder of your choosing, since sticks come and go.
"""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from . import audio
from .export import stick
from .library import Library

# player colour ids are already Crate's ids (1 pink .. 8 purple)
_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe(name: str) -> str:
    return _BAD.sub("_", name).strip(" .") or "Unknown"


def import_stick(lib: Library, root: str, dest: str, report=lambda *_: None) -> dict:
    root_p, dest_p = Path(root), Path(dest)
    db = stick.read_db(root_p)
    by_name: dict[tuple[str, int], int] = {}
    for path, (tid, _, size) in lib.known().items():
        by_name[(os.path.basename(path).lower(), size or 0)] = tid
    id_map: dict[int, int] = {}
    copied = matched = missing = 0
    tracks = db["tracks"]
    for i, t in enumerate(tracks, 1):
        if i % 10 == 0:
            report(f"Importing {i}/{len(tracks)}", 0.7 * i / len(tracks))
        src = root_p / t["file_path"].lstrip("/")
        if not src.is_file():
            missing += 1
            continue
        size = src.stat().st_size
        tid = by_name.get((src.name.lower(), size))
        if tid is None:
            artist = db["artists"].get(t["artist_id"], "") or "Unknown Artist"
            target = dest_p / _safe(artist) / _safe(src.name)
            if not (target.is_file() and target.stat().st_size == size):
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, target)
                copied += 1
            try:
                info = audio.probe(str(target))
            except Exception:
                missing += 1
                continue
            info.update({k: v for k, v in (("title", t["title"]), ("artist", db["artists"].get(t["artist_id"])),
                                           ("album", db["albums"].get(t["album_id"])), ("genre", db["genres"].get(t["genre_id"])),
                                           ("comment", t["comment"])) if v})
            tid = lib.upsert(str(target), info)
        else:
            matched += 1
        id_map[t["id"]] = tid
        fields = {k: v for k, v in (("rating", t["rating"]), ("color", t["color"]), ("year", t["year"]),
                                    ("key", db["keys"].get(t["key_id"]))) if v}
        if fields:
            lib.edit(tid, fields)
        if t["plays"]:
            lib.set_plays(tid, t["plays"])
        if t["analyze_path"]:
            base = root_p / t["analyze_path"].lstrip("/")
            try:
                dat = stick.tags(base.with_suffix(".DAT").read_bytes())
                grid = next((b for n, _, b in dat if n == "PQTZ"), b"")
                lib.import_grid(tid, stick.beats(grid))
                ext = base.with_suffix(".EXT")
                cues = stick.cues(stick.tags(ext.read_bytes()) if ext.is_file() else dat)
                if cues:
                    lib.set_cues(tid, cues)
            except (OSError, ValueError):
                pass  # a track without readable analysis still comes in; Crate analyses it

    existing = {(n["parent_id"], n["name"], bool(n["is_folder"])): n["id"] for n in lib.nodes()}
    made: dict[int, int] = {0: 0}
    playlists = 0
    pending = list(db["tree"])
    while pending:  # parents before children, whatever order the stick lists them in
        progress = False
        for n in list(pending):
            if n["parent"] not in made:
                continue
            key = (made[n["parent"]], n["name"], n["folder"])
            if key not in existing:
                existing[key] = lib.create_node(n["name"], made[n["parent"]], n["folder"])
            made[n["id"]] = existing[key]
            if not n["folder"]:
                lib.set_node_tracks(existing[key], [id_map[t] for t in db["entries"].get(n["id"], []) if t in id_map])
                playlists += 1
            pending.remove(n)
            progress = True
        if not progress:
            break
    return {"tracks": len(id_map), "copied": copied, "matched": matched, "missing": missing,
            "playlists": playlists, "ids": list(id_map.values())}
