"""DeviceSQL page layout used by Pioneer's export.pdb (little-endian, 4 KiB pages).

Layout follows Deep Symmetry's reverse-engineering (crate-digger) plus hardware-tested
details from open exporters: every table starts on an index page (flags 0x64), carries
its rows on 0x24 data pages and ends on a blank spare page named as empty_candidate.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field

PAGE = 4096
HEAP = 0x28
GROUP = 0x24  # 16 row offsets + present flags + transaction flags
EMPTY_INDEX = 0x1FFFFFF8


def dstr(text: str | None) -> bytes:
    """DeviceSQL string: short ASCII when it fits, long UTF-16LE otherwise."""
    if not text:
        return b"\x03"
    try:
        raw = text.encode("ascii")
        if len(raw) <= 126:
            return bytes([((len(raw) + 1) << 1) | 1]) + raw
        return struct.pack("<BHB", 0x40, len(raw) + 4, 0) + raw
    except UnicodeEncodeError:
        raw = text.encode("utf-16-le")
        return struct.pack("<BHB", 0x90, len(raw) + 4, 0) + raw


def dstr_utf16(text: str) -> bytes:
    raw = text.encode("utf-16-le")
    return struct.pack("<BHB", 0x90, len(raw) + 4, 0) + raw


@dataclass
class Table:
    type: int
    rows: list[bytes] = field(default_factory=list)
    shifted: bool = False  # rows carry a u16 index_shift at byte 2 (tracks, artists, albums)


def _paginate(rows: list[bytes]) -> list[list[bytes]]:
    pages, cur, used = [], [], 0
    for r in rows:
        size = len(r) + (-len(r) % 4)
        groups = (len(cur) + 1 + 15) // 16
        if cur and HEAP + used + size + groups * GROUP > PAGE:
            pages.append(cur)
            cur, used = [], 0
        cur.append(r)
        used += size
        if HEAP + used + GROUP > PAGE:
            raise ValueError("row larger than a page")
    if cur:
        pages.append(cur)
    return pages


def _header(page: bytearray, index: int, ttype: int, next_page: int, seq: int, n: int, flags: int) -> None:
    struct.pack_into("<IIIIII", page, 0, 0, index, ttype, next_page, seq, 0)
    page[0x18:0x1B] = ((n & 0x1FFF) | (n << 13)).to_bytes(3, "little")  # num_row_offsets, num_rows
    page[0x1B] = flags


def _data_page(index: int, ttype: int, next_page: int, seq: int, rows: list[bytes], shifted: bool) -> bytes:
    page = bytearray(PAGE)
    heap, offsets = bytearray(), []
    for i, r in enumerate(rows):
        offsets.append(len(heap))
        if shifted:  # index_shift counts rows within the page, in steps of 0x20
            r = r[:2] + struct.pack("<H", i * 0x20) + r[4:]
        heap += r
        heap += b"\0" * (-len(heap) % 4)
    n = len(rows)
    groups = (n + 15) // 16
    page[HEAP:HEAP + len(heap)] = heap
    for g in range(groups):
        base = PAGE - g * GROUP
        members = offsets[g * 16:(g + 1) * 16]
        for i, ofs in enumerate(members):
            struct.pack_into("<H", page, base - 6 - 2 * i, ofs)
        mask = (1 << len(members)) - 1
        struct.pack_into("<HH", page, base - 4, mask, mask)  # present, written in this transaction
    _header(page, index, ttype, next_page, seq, n, 0x24)
    # rekordbox charges 2 bytes per row offset and 4 per group's flag words, not whole groups
    free = PAGE - HEAP - len(heap) - (2 * n + 4 * groups)
    struct.pack_into("<HHHHHH", page, 0x1C, free, len(heap), n, 0, 0, 0)
    return bytes(page)


def _index_page(index: int, ttype: int, next_page: int, first_data: int | None, seq: int) -> bytes:
    """Index page as rekordbox writes it: the index header starts at 0x20 (inside the
    page header), the entry list at 0x3C, padded with empty entries to 20 bytes from the end."""
    page = bytearray(PAGE)
    _header(page, index, ttype, next_page, seq, 0, 0x64)
    struct.pack_into("<HHHH", page, 0x20, 0x1FFF, 0x1FFF, 0x03EC, 0)
    struct.pack_into("<IIIIHH", page, 0x28, index, first_data if first_data is not None else 0x03FFFFFF,
                     0x03FFFFFF, 0, 0, 0x1FFF)
    count = (PAGE - 20 - 0x3C) // 4
    struct.pack_into(f"<{count}I", page, 0x3C, *([EMPTY_INDEX] * count))
    return bytes(page)


def build(tables: list[Table], seq: int = 2) -> bytes:
    """Serialise tables, in the given order, into a complete .pdb file.

    Layout matches rekordbox: each table's index page then its data pages, table after
    table, with every table's spare (empty_candidate) page zero-filled at the end."""
    pages: list[bytes | None] = [None]
    plan = []
    for t in tables:
        data = _paginate(t.rows)
        first = len(pages)
        pages += [None] * (1 + len(data))
        plan.append((t, first, data))
    pointers = []
    for t, first, data in plan:
        spare = len(pages)
        pages.append(bytes(PAGE))
        chain = list(range(first + 1, first + 1 + len(data)))
        pages[first] = _index_page(first, t.type, chain[0] if chain else spare, chain[0] if chain else None, 1)
        for k, rows in enumerate(data):
            nxt = chain[k + 1] if k + 1 < len(chain) else spare
            pages[chain[k]] = _data_page(chain[k], t.type, nxt, seq, rows, t.shifted)
        pointers.append((t.type, spare, first, chain[-1] if chain else first))

    head = bytearray(PAGE)
    struct.pack_into("<IIIIIII", head, 0, 0, PAGE, len(tables), len(pages), 5, seq + 1, 0)
    for i, p in enumerate(pointers):
        struct.pack_into("<IIII", head, 0x1C + 16 * i, *p)
    pages[0] = bytes(head)
    return b"".join(pages)
