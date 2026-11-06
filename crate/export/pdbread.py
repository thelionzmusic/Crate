"""Read play history back off a stick's export.pdb.

Players log what you play into the history tables (types 0x0B, 0x0C) of the stick's
database. Crate reads them before every export, because writing a fresh database would
otherwise throw that history away.
"""
from __future__ import annotations

import struct
from pathlib import Path

T_HISTORY_PLAYLISTS, T_HISTORY_ENTRIES = 0x0B, 0x0C


def _string(d: bytes, pos: int) -> str:
    lk = d[pos]
    if lk & 1:
        return d[pos + 1:pos + (lk >> 1)].decode("ascii", "replace")
    length = struct.unpack_from("<H", d, pos + 1)[0]
    raw = d[pos + 4:pos + length]
    return raw.decode("utf-16-le", "replace") if lk == 0x90 else raw.decode("ascii", "replace")


def _rows(d: bytes, table: int):
    """Byte offsets of every live row in a table, walking its page chain."""
    page = struct.unpack_from("<I", d, 4)[0]
    for i in range(struct.unpack_from("<I", d, 8)[0]):
        ttype, _, first, last = struct.unpack_from("<IIII", d, 0x1C + 16 * i)
        if ttype != table:
            continue
        p, seen = first, set()
        while p not in seen and (p + 1) * page <= len(d):
            seen.add(p)
            b = p * page
            if not d[b + 0x1B] & 0x40:
                n = int.from_bytes(d[b + 0x18:b + 0x1B], "little") & 0x1FFF
                for g in range((n + 15) // 16):
                    base = b + page - g * 0x24
                    present = struct.unpack_from("<H", d, base - 4)[0]
                    for r in range(min(16, n - 16 * g)):
                        if present >> r & 1:
                            yield b + 0x28 + struct.unpack_from("<H", d, base - 6 - 2 * r)[0]
            if p == last:
                break
            p = struct.unpack_from("<I", d, b + 12)[0]


def history(pdb_path: Path) -> list[dict]:
    """[{name, tracks: [track ids in play order]}] for each history session on the stick."""
    try:
        d = Path(pdb_path).read_bytes()
    except OSError:
        return []
    if len(d) < 4096 or struct.unpack_from("<I", d, 4)[0] != 4096:
        return []
    names = {}
    for o in _rows(d, T_HISTORY_PLAYLISTS):
        names[struct.unpack_from("<I", d, o)[0]] = _string(d, o + 4)
    plays: dict[int, list[tuple[int, int]]] = {}
    for o in _rows(d, T_HISTORY_ENTRIES):
        track, playlist, index = struct.unpack_from("<III", d, o)
        plays.setdefault(playlist, []).append((index, track))
    return [{"name": names.get(pid, f"History {pid}"), "tracks": [t for _, t in sorted(entries)]}
            for pid, entries in sorted(plays.items())]
