"""export.pdb / exportExt.pdb: the database every Pioneer player browses from."""
from __future__ import annotations

import datetime as dt
import struct
from dataclasses import dataclass, field
from pathlib import Path

from .devicesql import Table, build, dstr, dstr_utf16

T_TRACKS, T_GENRES, T_ARTISTS, T_ALBUMS, T_LABELS, T_KEYS, T_COLORS = range(7)
T_PLAYLIST_TREE, T_PLAYLIST_ENTRIES = 7, 8
T_ARTWORK, T_COLUMNS, T_MENU, T_SORT, T_HISTORY = 0x0D, 0x10, 0x11, 0x12, 0x13
TABLE_COUNT = 0x14  # players reject files missing any of the 20 tables, or out of order

COLORS = ["Pink", "Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple"]

# Browse columns (id, code, label), as written by rekordbox.
COLUMNS = [
    (1, 0x80, "GENRE"), (2, 0x81, "ARTIST"), (3, 0x82, "ALBUM"), (4, 0x83, "TRACK"), (5, 0x85, "BPM"),
    (6, 0x86, "RATING"), (7, 0x87, "YEAR"), (8, 0x88, "REMIXER"), (9, 0x89, "LABEL"),
    (10, 0x8A, "ORIGINAL ARTIST"), (11, 0x8B, "KEY"), (12, 0x8D, "CUE"), (13, 0x8E, "COLOR"),
    (14, 0x92, "TIME"), (15, 0x93, "BITRATE"), (16, 0x94, "FILE NAME"), (17, 0x84, "PLAYLIST"),
    (18, 0x98, "HOT CUE BANK"), (19, 0x95, "HISTORY"), (20, 0x91, "SEARCH"), (21, 0x96, "COMMENTS"),
    (22, 0x8C, "DATE ADDED"), (23, 0x97, "DJ PLAY COUNT"), (24, 0x90, "FOLDER"), (25, 0xA1, "DEFAULT"),
    (26, 0xA2, "ALPHABET"), (27, 0xAA, "MATCHING"),
]

# Browse menu (category, content, unknown, visibility, position) and sort list rows,
# byte for byte as rekordbox 7 writes them. Visibility: 0 shown, 1 hidden, 2 shown (MATCHING).
MENU_ROWS = [
    (1, 1, 0x63, 1, 0), (5, 6, 0x05, 1, 0), (6, 7, 0x63, 1, 0), (7, 8, 0x63, 1, 0), (8, 9, 0x63, 1, 0),
    (9, 10, 0x63, 1, 0), (10, 11, 0x63, 1, 0), (13, 15, 0x63, 1, 0), (14, 19, 0x04, 1, 0), (15, 20, 0x06, 1, 0),
    (16, 21, 0x63, 1, 0), (18, 23, 0x63, 1, 0), (2, 2, 0x02, 0, 1), (3, 3, 0x03, 0, 2), (4, 4, 0x01, 0, 3),
    (11, 12, 0x63, 0, 4), (17, 5, 0x63, 0, 5), (19, 22, 0x63, 0, 6), (20, 18, 0x63, 0, 7), (27, 26, 0x63, 2, 8),
    (24, 17, 0x63, 0, 9), (22, 27, 0x63, 0, 10),
]
SORT_ROWS = [
    (1, 6, 1, 0), (21, 7, 1, 0), (14, 8, 1, 0), (8, 9, 1, 0), (9, 10, 1, 0), (10, 11, 1, 0), (15, 13, 1, 0),
    (13, 15, 1, 0), (23, 16, 1, 0), (22, 17, 1, 0), (25, 0, 0, 1), (26, 1, 0, 2), (2, 2, 0, 3), (3, 3, 0, 4),
    (5, 4, 0, 5), (6, 5, 0, 6), (11, 12, 0, 7),
]

# File type codes in the track row (rekordbox: 1 MP3, 4 AAC, 5 FLAC, 6 ALAC, 11 WAV, 12 AIFF).
FILE_TYPES = {"mp3": 1, "aac": 4, "flac": 5, "alac": 6, "wav": 11, "aiff": 12}
EXT_TEMPLATE = Path(__file__).with_name("templates") / "exportExt.pdb"


@dataclass
class TrackRow:
    id: int
    title: str
    file_path: str          # on the device, e.g. /Contents/Artist/Album/file.mp3
    analyze_path: str       # /PIONEER/USBANLZ/.../ANLZ0000.DAT
    sample_rate: int
    file_size: int
    bitrate: int
    tempo_x100: int
    duration_s: int
    sample_depth: int
    artist_id: int = 0
    album_id: int = 0
    genre_id: int = 0
    label_id: int = 0
    remixer_id: int = 0
    key_id: int = 0
    artwork_id: int = 0
    color_id: int = 0
    rating: int = 0
    year: int = 0
    track_number: int = 0
    play_count: int = 0
    comment: str = ""
    date_added: str = ""
    analyze_date: str = ""
    mix_name: str = ""
    file_type: int = 1


@dataclass
class Node:
    id: int
    name: str
    parent_id: int = 0
    is_folder: bool = False
    sort: int = 0
    track_ids: list[int] = field(default_factory=list)


def _track(i: int, t: TrackRow) -> bytes:
    head = struct.pack(
        "<HHIIIIIHH" + "I" * 12 + "HHHHHHBBHH",
        0x24, 0, 0x000C0700, t.sample_rate, 0, t.file_size, t.id, 0x7C92, 0x332A,
        t.artwork_id, t.key_id, 0, t.label_id, t.remixer_id, t.bitrate, t.track_number,
        t.tempo_x100, t.genre_id, t.album_id, t.artist_id, t.id,
        0, t.play_count, t.year, t.sample_depth, min(t.duration_s, 0xFFFF), 0x29, t.color_id, t.rating,
        t.file_type, 3)
    name = t.file_path.rsplit("/", 1)[-1]
    strings = ["", "", "5", "2", "", "", "ON", "ON", "", "", t.date_added, "", t.mix_name, "",
               t.analyze_path, t.analyze_date, t.comment, t.title, "", name, t.file_path]
    base = len(head) + 2 * len(strings)
    blobs, offsets = [], []
    for s in strings:
        offsets.append(base + sum(map(len, blobs)))
        blobs.append(dstr(s))
    return head + struct.pack(f"<{len(offsets)}H", *offsets) + b"".join(blobs)


def _named(rows: dict[str, int], fmt=lambda i, n, idx: struct.pack("<I", i) + dstr(n)) -> list[bytes]:
    return [fmt(i, n, k) for k, (n, i) in enumerate(sorted(rows.items(), key=lambda kv: kv[1]))]


def export_pdb(tracks: list[TrackRow], artists: dict[str, int], albums: dict[tuple[str, int], int],
               genres: dict[str, int], labels: dict[str, int], keys: dict[str, int],
               artwork: dict[str, int], nodes: list[Node], menu_tables: bool = True) -> bytes:
    tables = {t: Table(t) for t in range(TABLE_COUNT)}
    for t in (T_TRACKS, T_ARTISTS, T_ALBUMS):
        tables[t].shifted = True
    tables[T_TRACKS].rows = [_track(i, t) for i, t in enumerate(tracks)]
    tables[T_GENRES].rows = _named(genres)
    tables[T_ARTISTS].rows = _named(artists, lambda i, n, k: struct.pack("<HHIBB", 0x60, 0, i, 3, 10) + dstr(n))
    tables[T_ALBUMS].rows = [struct.pack("<HHIIIIBB", 0x80, 0, 0, artist, i, 0, 3, 22) + dstr(name)
                             for (name, artist), i in sorted(albums.items(), key=lambda kv: kv[1])]
    tables[T_LABELS].rows = _named(labels)
    tables[T_KEYS].rows = _named(keys, lambda i, n, k: struct.pack("<II", i, i) + dstr(n))
    tables[T_COLORS].rows = [struct.pack("<IBHB", 0, i + 1, i + 1, 0) + dstr(n) for i, n in enumerate(COLORS)]
    tables[T_PLAYLIST_TREE].rows = [struct.pack("<IIIII", n.parent_id, 0, n.sort, n.id, int(n.is_folder)) + dstr(n.name)
                                    for n in nodes]
    tables[T_PLAYLIST_ENTRIES].rows = [struct.pack("<III", pos + 1, tid, n.id)
                                       for n in nodes if not n.is_folder for pos, tid in enumerate(n.track_ids)]
    tables[T_ARTWORK].rows = _named(artwork)
    tables[T_COLUMNS].rows = [struct.pack("<HH", i, code) + dstr_utf16(f"￺{label}￻") for i, code, label in COLUMNS]
    if menu_tables:
        tables[T_MENU].rows = [struct.pack("<HHBBH", *r) for r in MENU_ROWS]
        tables[T_SORT].rows = [struct.pack("<HHBBH", *r, 0) for r in SORT_ROWS]
    tables[T_HISTORY].rows = [struct.pack("<HHII", 0x280, 0x160, 0x0B, 0) + dstr(dt.date.today().isoformat())
                              + bytes([0x19, 0x1E]) + dstr("1000") + dstr("")]
    return build([tables[t] for t in range(TABLE_COUNT)])


def export_ext_pdb() -> bytes:
    """exportExt.pdb with rekordbox's default My Tag categories and no tagged tracks."""
    return EXT_TEMPLATE.read_bytes()
