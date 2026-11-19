"""ANLZ analysis files (.DAT / .EXT / .2EX): beatgrid, cues and waveforms (big-endian)."""
from __future__ import annotations

import bisect
import struct
from dataclasses import dataclass

import numpy as np

from ..analysis.waveform import resample


@dataclass
class Cue:
    hot: int               # 0 = memory cue, 1..8 = hot cue A..H
    start_ms: int
    end_ms: int = -1       # loop end, -1 for a plain cue
    rgb: tuple[int, int, int] | None = None
    name: str = ""


def _tag(fourcc: bytes, head: bytes, body: bytes) -> bytes:
    lh = 12 + len(head)
    return fourcc + struct.pack(">II", lh, lh + len(body)) + head + body


def _file(tags: list[bytes]) -> bytes:
    body = b"".join(tags)
    return b"PMAI" + struct.pack(">IIIIII", 28, 28 + len(body), 1, 0x10000, 0x10000, 0) + body


def folder(file_path: str) -> str:
    """Where a player looks for a track's analysis: /PIONEER/USBANLZ/P###/########.

    Players don't take this from the library: they work it out from the track's path on the
    stick, so analysis anywhere else is never found and the player analyses the track itself
    (slowly, with no detail waveform). The hash runs over the path's UTF-16 code units, then
    the P folder is seven of its bits. Checked against every track of a real rekordbox export."""
    n = 0
    for unit in memoryview(file_path.encode("utf-16-le")).cast("H"):
        n = ((n * 0x5BC9 + unit) * 0x93B5 + unit) & 0xFFFFFFFF
    n %= 200003
    p = sum(((n >> bit) & 1) << i for i, bit in enumerate((0, 2, 6, 7, 9, 13, 16)))
    return f"/PIONEER/USBANLZ/P{p:03X}/{n:08X}"


def _path(p: str) -> bytes:
    raw = p.encode("utf-16-be") + b"\0\0"
    return _tag(b"PPTH", struct.pack(">I", len(raw)), raw)


def _vbr(vbr: tuple[list[int], int] | None) -> bytes:
    """PVBR: an MP3's seek index (400 byte offsets for VBR, zeros otherwise), then its decoded
    length in samples, which players take the track length from (level.mp3_vbr). Other
    formats: all zeros."""
    index, samples = vbr or ([0] * 400, 0)
    return _tag(b"PVBR", struct.pack(">I", 0), struct.pack(">400I", *index) + struct.pack(">I", samples))


def _grid(beats: list[tuple[int, float]], bpm: float, tempos: list[dict] | None = None) -> bytes:
    """PQTZ: every beat with its bar position and the tempo leading into it, so tracks that
    change tempo (or drift, played live) show their real BPM on the player as they go.
    `tempos` ([{ms, bpm}] section starts) gives each section's exact tempo."""
    times = np.array([t for _, t in beats], np.float64)
    gaps = np.diff(times) if len(times) > 1 else np.zeros(0)
    starts = [x["ms"] - 1.0 for x in tempos] if tempos else []
    body = b""
    for i, (n, t) in enumerate(beats):
        if tempos:
            local = tempos[max(0, bisect.bisect_right(starts, t) - 1)]["bpm"]
        else:
            near = gaps[max(0, i - 2):i + 3]  # median of the gaps around this beat: steady through jitter
            local = 60000.0 / float(np.median(near)) if len(near) and np.median(near) > 0 else bpm
        if not bpm or not 0.5 < local / bpm < 2.0:
            local = bpm
        body += struct.pack(">HHI", n, int(round(local * 100)), int(round(t)))
    return _tag(b"PQTZ", struct.pack(">III", 0, 0x80000, len(beats)), body)


def _cues(cues: list[Cue], hot: bool) -> bytes:
    sel = sorted((c for c in cues if (c.hot > 0) == hot), key=lambda c: (c.hot, c.start_ms))
    body = b""
    for i, c in enumerate(sel):
        order_first = 0xFFFF if i == 0 else i - 1
        order_last = 0xFFFF if i == len(sel) - 1 else i + 1
        loop = c.end_ms if c.end_ms >= 0 else 0xFFFFFFFF
        body += b"PCPT" + struct.pack(">IIIIIHHBBHII", 28, 56, c.hot, 1, 0x10000, order_first, order_last,
                                      2 if c.end_ms >= 0 else 1, 0, 0x3E8, c.start_ms, loop) + b"\0" * 16
    head = struct.pack(">IHHI", int(hot), 0, len(sel), 0xFFFFFFFF)
    return _tag(b"PCOB", head, body)


def _cues2(cues: list[Cue], hot: bool) -> bytes:
    sel = sorted((c for c in cues if (c.hot > 0) == hot), key=lambda c: (c.hot, c.start_ms))
    body = b""
    for c in sel:
        comment = c.name.encode("utf-16-be") + b"\0\0" if c.name else b""
        r, g, b = c.rgb or (0, 0, 0)
        loop = c.end_ms if c.end_ms >= 0 else 0xFFFFFFFF
        entry = struct.pack(">IB3xIIB7xHHI", c.hot, 2 if c.end_ms >= 0 else 1, c.start_ms, loop, 0, 0, 0, len(comment))
        entry += comment + bytes([1 if c.rgb else 0, r, g, b])
        entry += b"\0" * (-(len(entry) + 12) % 4)
        body += b"PCP2" + struct.pack(">II", 16, 12 + len(entry)) + entry
    return _tag(b"PCO2", struct.pack(">IHH", int(hot), len(sel), 0), body)


# ---- waveforms -------------------------------------------------------------

def _heights(w: np.ndarray, top: int) -> np.ndarray:
    """Column heights on the players' scale (0..top), matched to rekordbox's: a little under
    the raw peak, so quiet passages sit low and only real peaks reach the top."""
    return np.clip(w.max(axis=1).astype(np.float32) / 255.0 * top * 1.12 - top * 0.09, 0, top)


def _white(w: np.ndarray) -> np.ndarray:
    """Monochrome 'whiteness' (0..7): more treble, whiter; centred where rekordbox centres it."""
    f = w.astype(np.float32)
    return np.clip(f[:, 2] / (f.sum(axis=1) + 1e-6) * 6.7 + 3.1, 0, 7).astype(np.uint8)


def _overview(heights: np.ndarray, cols: int, gain: float, floor: float, top: int) -> np.ndarray:
    """A preview's columns from the detail heights: the RMS of each stretch, as rekordbox's
    previews read (the peak would pin a loud track's whole preview to the top)."""
    edges = np.linspace(0, len(heights), cols + 1).astype(int)
    sq = np.concatenate([[0.0], np.cumsum(heights.astype(np.float64) ** 2)])
    span = np.maximum(edges[1:] - edges[:-1], 1)
    rms = np.sqrt((sq[np.minimum(edges[1:], len(heights))] - sq[edges[:-1]]) / span)
    return np.clip(np.round(rms * gain + floor), 0, top).astype(np.uint8)


def _rgb(w: np.ndarray) -> np.ndarray:
    """Pioneer RGB (0..7 each): lows red, mids green, highs blue, balanced as rekordbox's are."""
    f = w.astype(np.float32)
    norm = f / (f.max(axis=1, keepdims=True) + 1e-6) * 7
    norm = norm * np.array([0.875, 0.59, 0.75], np.float32) + np.array([0.27, 0.9, 2.9], np.float32)
    return np.clip(np.round(norm), 0, 7).astype(np.uint8)


def _wave_tags(wave: np.ndarray) -> tuple[bytes, bytes, bytes, bytes, bytes, bytes, bytes, bytes]:
    n = len(wave)
    detail = _heights(wave, 31)
    h = _overview(detail, 400, 0.84, 3.4, 31)
    wh = np.clip(_white(resample(wave, 400)).astype(np.float32) * 0.34 + 2.0, 0, 7).astype(np.uint8)
    pwav = _tag(b"PWAV", struct.pack(">II", 400, 0x10000), ((wh << 5) | h).tobytes())
    pwv2 = _tag(b"PWV2", struct.pack(">II", 100, 0x10000), _overview(detail, 100, 0.375, 6.3, 15).tobytes())

    h = np.round(detail).astype(np.uint8)
    pwv3 = _tag(b"PWV3", struct.pack(">III", 1, n, 0x960000), ((_white(wave) << 5) | h).tobytes())

    # PWV4, the colour overview: three summary bytes, then low / mid / high on one shared
    # 0..127 scale. The summary bytes follow a fit against real rekordbox exports.
    p1200 = resample(wave, 1200)
    bands = p1200.astype(np.float32) * 127 / 255
    lo, mid, hi = bands[:, 0], bands[:, 1], bands[:, 2]
    top, total = bands.max(axis=1), bands.sum(axis=1)
    summary = [41 + 0.47 * top + 0.15 * total, 204 - 0.33 * top - 0.15 * total, 13 + 0.6 * lo + 0.25 * mid]
    cols = [np.clip(np.round(c), 0, lim) for c, lim in zip(summary, (127, 255, 127))] + [lo, mid, hi]
    pwv4 = _tag(b"PWV4", struct.pack(">III", 6, 1200, 0), np.column_stack(cols).round().astype(np.uint8).tobytes())

    rgb = _rgb(wave).astype(np.uint16)
    words = (rgb[:, 0] << 13) | (rgb[:, 1] << 10) | (rgb[:, 2] << 7) | (h.astype(np.uint16) << 2)
    pwv5 = _tag(b"PWV5", struct.pack(">III", 2, n, 0x960305), words.astype(">u2").tobytes())

    # The 3-band view (CDJ-3000): bytes are low, mid, high, the first byte following the bass
    # in every real export. Like rekordbox, each band is scaled on its own so hi-hats show:
    # the detail lifts any band peaking under 102 up to 102 and records its gain in PWVC
    # (never below 80, 100 at full scale); the overview evens the bands to the same average.
    detail = wave.astype(np.float32) * 127 / 255
    peak = detail.max(axis=0) if n else np.zeros(3, np.float32)
    detail *= np.where((peak > 0) & (peak < 102), 102 / np.maximum(peak, 1e-6), 1.0)
    gains = [max(80, int(round(p * 100 / 127))) for p in peak]
    over = p1200.astype(np.float32) * 127 / 255
    avg = over.mean(axis=0)
    over *= np.where(avg > 0, 27 / np.maximum(avg, 1e-6), 1.0)
    as_bytes = lambda w: np.clip(np.round(w), 0, 127).astype(np.uint8).tobytes()  # noqa: E731

    pwv6 = _tag(b"PWV6", struct.pack(">II", 3, 1200), as_bytes(over))
    pwv7 = _tag(b"PWV7", struct.pack(">III", 3, n, 0x960000), as_bytes(detail))
    pwvc = _tag(b"PWVC", struct.pack(">H", 0), struct.pack(">3H", *gains))
    return pwav, pwv2, pwv3, pwv4, pwv5, pwv6, pwv7, pwvc


# Phrase kinds for the "high" mood (dance music): 1 intro, 2 up, 3 down, 5 chorus, 6 outro.
PHRASE_KINDS = {"Intro": 1, "Verse": 2, "Build": 2, "Drop": 5, "Breakdown": 3, "Outro": 6}


def build(track_path: str, beats: list[tuple[int, float]], bpm: float, wave: np.ndarray,
          cues: list[Cue], vbr: tuple[list[int], int] | None,
          tempos: list[dict] | None = None) -> tuple[bytes, bytes, bytes]:
    """Return (DAT, EXT, 2EX) file contents for one track."""
    pwav, pwv2, pwv3, pwv4, pwv5, pwv6, pwv7, pwvc = _wave_tags(wave)
    path, grid = _path(track_path), _grid(beats, bpm, tempos)
    hot, mem = _cues(cues, True), _cues(cues, False)
    dat = _file([path, _vbr(vbr), grid, pwav, pwv2, hot, mem])
    ext = _file([path, pwv3, hot, mem, _cues2(cues, True), _cues2(cues, False), pwv5, pwv4])  # rekordbox's order
    ex2 = _file([path, pwv7, pwv6, pwvc])  # rekordbox's order
    return dat, ext, ex2
