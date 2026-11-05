"""Independent export.pdb / ANLZ reader, written from the crate-digger spec, for tests."""
import struct

PAGE_TYPES = {0: "tracks", 1: "genres", 2: "artists", 3: "albums", 4: "labels", 5: "keys", 6: "colors",
              7: "playlist_tree", 8: "playlist_entries", 13: "artwork", 16: "columns", 17: "menu", 18: "sort"}


def read_string(buf, pos):
    lk = buf[pos]
    if lk & 1:
        n = (lk >> 1) - 1
        return buf[pos + 1:pos + 1 + n].decode("ascii")
    length = struct.unpack_from("<H", buf, pos + 1)[0]
    raw = buf[pos + 4:pos + length]
    if lk == 0x40:
        return raw.decode("ascii")
    if lk == 0x90:
        return raw.decode("utf-16-le")
    raise ValueError(f"bad string kind {lk:#x} at {pos:#x}")


def read_pdb(data: bytes) -> dict:
    _, len_page, num_tables, next_unused, _u, seq = struct.unpack_from("<IIIIII", data, 0)
    assert len_page == 4096 and len(data) % len_page == 0 and len(data) <= next_unused * len_page, "file length"
    tables = {}
    for i in range(num_tables):
        ttype, empty, first, last = struct.unpack_from("<IIII", data, 0x1C + 16 * i)
        assert ttype == i, "tables out of order"
        rows, page_i, guard = [], first, 0
        while True:
            base = page_i * len_page
            _, idx, ptype, nxt = struct.unpack_from("<IIII", data, base)
            assert idx == page_i and ptype == ttype, f"page header mismatch at {page_i}"
            packed = int.from_bytes(data[base + 0x18:base + 0x1B], "little")
            num_offsets, num_rows = packed & 0x1FFF, packed >> 13
            flags = data[base + 0x1B]
            if flags & 0x40 == 0:
                free, used = struct.unpack_from("<HH", data, base + 0x1C)
                assert free + used + 2 * num_offsets + 4 * ((num_offsets + 15) // 16) + 0x28 == len_page, \
                    f"free/used accounting on page {page_i}"
                for g in range((num_offsets + 15) // 16):
                    gbase = base + len_page - g * 0x24
                    present = struct.unpack_from("<H", data, gbase - 4)[0]
                    for r in range(16):
                        if present >> r & 1:
                            ofs = struct.unpack_from("<H", data, gbase - 6 - 2 * r)[0]
                            rows.append(base + 0x28 + ofs)
            else:
                assert flags == 0x64
            if page_i == last:
                break
            page_i, guard = nxt, guard + 1
            assert guard < 10000
        assert empty not in (first, last)
        tables[ttype] = [parse_row(ttype, data, p) for p in rows]
    return tables


def parse_row(t, d, p):
    u4 = lambda o: struct.unpack_from("<I", d, p + o)[0]  # noqa: E731
    if t == 0:
        f = struct.unpack_from("<HHIIIIIHH" + "I" * 12 + "HHHHHHBBHH", d, p)
        offs = struct.unpack_from("<21H", d, p + 0x5E)
        s = [read_string(d, p + o) for o in offs]
        return {"id": f[20], "sample_rate": f[3], "file_size": f[5], "key_id": f[10], "bitrate": f[14],
                "tempo": f[16], "genre_id": f[17], "album_id": f[18], "artist_id": f[19], "artwork_id": f[9],
                "depth": f[24], "duration": f[25], "file_type": f[29], "title": s[17], "file_path": s[20], "filename": s[19],
                "analyze_path": s[14], "date_added": s[10]}
    if t in (1, 4, 13):
        return {"id": u4(0), "name": read_string(d, p + 4)}
    if t == 2:
        return {"id": u4(4), "name": read_string(d, p + d[p + 9])}
    if t == 3:
        return {"artist_id": u4(8), "id": u4(12), "name": read_string(d, p + d[p + 21])}
    if t == 5:
        return {"id": u4(0), "name": read_string(d, p + 8)}
    if t == 6:
        return {"id": struct.unpack_from("<H", d, p + 5)[0], "name": read_string(d, p + 8)}
    if t == 7:
        parent, _, sort, nid, folder = struct.unpack_from("<IIIII", d, p)
        return {"parent": parent, "sort": sort, "id": nid, "folder": bool(folder), "name": read_string(d, p + 20)}
    if t == 8:
        e, tr, pl = struct.unpack_from("<III", d, p)
        return {"entry": e, "track": tr, "playlist": pl}
    if t == 16:
        cid, code = struct.unpack_from("<HH", d, p)
        return {"id": cid, "code": code, "name": read_string(d, p + 4).strip("￺￻")}
    if t in (17, 18):
        return struct.unpack_from("<HHBBH", d, p)
    return None


def read_anlz(data: bytes) -> dict:
    assert data[:4] == b"PMAI"
    lh, lf = struct.unpack_from(">II", data, 4)
    assert lf == len(data), "anlz length"
    pos, tags = lh, {}
    while pos < len(data):
        fourcc = data[pos:pos + 4].decode()
        h, ln = struct.unpack_from(">II", data, pos + 4)
        assert h <= ln and pos + ln <= len(data), f"bad tag {fourcc}"
        tags.setdefault(fourcc, []).append(data[pos:pos + ln])
        pos += ln
    return tags


def anlz_beats(tag: bytes):
    n = struct.unpack_from(">I", tag, 20)[0]
    return [struct.unpack_from(">HHI", tag, 24 + 8 * i) for i in range(n)]


def anlz_path(tag: bytes) -> str:
    n = struct.unpack_from(">I", tag, 12)[0]
    return tag[16:16 + n - 2].decode("utf-16-be")


def anlz_cues(tag: bytes):
    ctype, _, num, _ = struct.unpack_from(">IHHI", tag, 12)
    out, pos = [], 24
    for _ in range(num):
        assert tag[pos:pos + 4] == b"PCPT"
        _, ln = struct.unpack_from(">II", tag, pos + 4)
        hot, = struct.unpack_from(">I", tag, pos + 12)
        kind = tag[pos + 28]
        t, loop = struct.unpack_from(">II", tag, pos + 32)
        out.append((hot, kind, t, loop))
        pos += ln
    return ctype, out
