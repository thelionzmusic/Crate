"""Import a rekordbox collection (File > Export Collection in xml format):
tracks, beatgrids, hot/memory cues with colours, ratings and the playlist tree."""
from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote, urlparse

from . import audio
from .library import Library

# rekordbox track colours -> player colour ids (Pink, Red, Orange, Yellow, Green, Aqua, Blue, Purple)
COLOUR_IDS = {"0xFF007F": 1, "0xFF0000": 2, "0xFFA500": 3, "0xFFFF00": 4, "0x00FF00": 5,
              "0x25FDE9": 6, "0x0000FF": 7, "0x660099": 8}


def _path(location: str) -> str:
    u = urlparse(location)
    p = unquote(u.path)
    if os.name == "nt" and len(p) > 2 and p[0] == "/" and p[2] == ":":
        p = p[1:]
    return str(Path(p))


def _xml_beats(tempos, duration_s: float) -> list[tuple[int, float, float]]:
    """rekordbox TEMPO anchors -> [(beat in bar, bpm, ms)]. One anchor is a steady grid;
    several mean the tempo changes, so every beat is laid out section by section."""
    anchors = sorted((float(t.get("Inizio", 0)) * 1000.0, float(t.get("Bpm", 0)), int(t.get("Battito", "1") or 1))
                     for t in tempos if float(t.get("Bpm", 0) or 0) > 0)
    if len(anchors) <= 1:
        return [(bar, bpm, ms) for ms, bpm, bar in anchors]
    out = []
    for i, (ms, bpm, bar) in enumerate(anchors):
        end = anchors[i + 1][0] if i + 1 < len(anchors) else max(duration_s * 1000.0, ms)
        period, k = 60000.0 / bpm, 0
        while ms + k * period < end - 1:
            out.append(((bar - 1 + k) % 4 + 1, bpm, ms + k * period))
            k += 1
    return out


class _Finder:
    """Finds a track rekordbox lists at a path that isn't on this computer (a library moved
    from a Mac, or a different drive letter), by file name and size in your music folders."""

    def __init__(self, folders: list[str]):
        self.folders, self.index = folders, None

    def find(self, path: str, size: int | None) -> str | None:
        if self.index is None:
            self.index = {}
            for folder in self.folders:
                for dirpath, _, files in os.walk(folder):
                    for f in files:
                        self.index.setdefault(f.lower(), []).append(os.path.join(dirpath, f))
        name = path.replace("\\", "/").rsplit("/", 1)[-1].lower()
        hits = self.index.get(name, [])
        if size:
            sized = [h for h in hits if os.path.getsize(h) == size]
            if sized:
                return sized[0]
        return hits[0] if len(hits) == 1 else None


def import_xml(lib: Library, xml_path: str, report=lambda *_: None) -> dict:
    root = ET.parse(xml_path).getroot()
    coll = root.find("COLLECTION")
    entries = list(coll) if coll is not None else []
    id_map: dict[str, int] = {}
    missing, found = 0, 0
    finder = _Finder([r["path"] for r in lib.q("SELECT path FROM folders")] + [str(Path(xml_path).parent)])
    for i, t in enumerate(entries, 1):
        path = _path(t.get("Location", ""))
        if not Path(path).is_file():
            path = finder.find(path, int(t.get("Size") or 0) or None) or ""
            if not path:
                missing += 1
                continue
            found += 1
        try:
            info = audio.probe(path)
        except Exception:
            missing += 1
            continue
        for xml_k, k in (("Name", "title"), ("Artist", "artist"), ("Album", "album"), ("Genre", "genre"),
                         ("Label", "label"), ("Remixer", "remixer"), ("Comments", "comment")):
            if t.get(xml_k):
                info[k] = t.get(xml_k)
        tid = lib.upsert(path, info)
        id_map[t.get("TrackID")] = tid
        fields: dict = {}
        if t.get("Rating"):
            fields["rating"] = min(5, int(t.get("Rating")) // 51)
        if t.get("Colour") in COLOUR_IDS:
            fields["color"] = COLOUR_IDS[t.get("Colour")]
        if t.get("Tonality"):
            fields["key"] = t.get("Tonality")
        if (t.get("Year") or "0").isdigit() and int(t.get("Year") or 0) > 0:
            fields["year"] = int(t.get("Year"))
        if fields:
            lib.edit(tid, fields)
        lib.import_grid(tid, _xml_beats(t.findall("TEMPO"), float(t.get("TotalTime") or 0)))
        if (t.get("PlayCount") or "0").isdigit():
            lib.set_plays(tid, int(t.get("PlayCount") or 0))
        if t.get("DateAdded"):
            lib.x("UPDATE tracks SET date_added = ? WHERE id = ?", (t.get("DateAdded")[:10], tid))
        cues = []
        for m in t.findall("POSITION_MARK"):
            num = int(m.get("Num", "-1"))
            if m.get("Type") not in ("0", "4"):
                continue
            colour = None
            if m.get("Red") is not None:
                colour = "#%02x%02x%02x" % (int(m.get("Red")), int(m.get("Green")), int(m.get("Blue")))
            end = int(float(m.get("End")) * 1000) if m.get("Type") == "4" and m.get("End") else -1
            cues.append({"slot": num + 1 if num >= 0 else 0, "start_ms": int(float(m.get("Start")) * 1000),
                         "end_ms": end, "color": colour, "name": m.get("Name", "")})
        if cues:
            lib.set_cues(tid, cues)
        if i % 50 == 0:
            report(f"Importing {i}/{len(entries)}", 0.6 * i / len(entries))

    playlists = 0
    existing = {(n["parent_id"], n["name"], bool(n["is_folder"])): n["id"] for n in lib.nodes()}

    def node(name: str, parent: int, folder: bool) -> int:
        """Reuse a same-named node so re-importing updates playlists instead of duplicating them."""
        key = (parent, name, folder)
        if key not in existing:
            existing[key] = lib.create_node(name, parent, folder)
        return existing[key]

    def walk(xml_node, parent: int) -> None:
        nonlocal playlists
        for child in xml_node.findall("NODE"):
            if child.get("Type") == "0":
                walk(child, node(child.get("Name"), parent, True))
            else:
                nid = node(child.get("Name"), parent, False)
                lib.set_node_tracks(nid, [id_map[e.get("Key")] for e in child.findall("TRACK") if e.get("Key") in id_map])
                playlists += 1

    pl_root = root.find("PLAYLISTS/NODE")  # rekordbox's own ROOT node: its children go at the top level
    if pl_root is not None:
        walk(pl_root, 0)
    return {"tracks": len(id_map), "missing": missing, "found": found, "playlists": playlists, "ids": list(id_map.values())}
