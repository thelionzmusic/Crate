"""ANLZ analysis files (.DAT / .EXT / .2EX): beatgrid, cues and waveforms (big-endian)."""
from __future__ import annotations

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


def _path(p: str) -> bytes:
    raw = p.encode("utf-16-be") + b"\0\0"
    return _tag(b"PPTH", struct.pack(">I", len(raw)), raw)


def _vbr(index: list[int] | None) -> bytes:
    idx = list(index or [])[:400]
    idx += [0] * (401 - len(idx))  # rekordbox writes 401 words
    return _tag(b"PVBR", struct.pack(">I", 0), struct.pack(">401I", *idx))


def _grid(beats: list[tuple[int, float]], bpm: float) -> bytes:
    """PQTZ: every beat with its bar position and the tempo leading into it, so drifting
    tracks keep their real timing on the player."""
    times = [t for _, t in beats]
    body = b""
    for i, (n, t) in enumerate(beats):
        gap = (times[i + 1] - t) if i + 1 < len(times) else (t - times[i - 1] if i else 0)
        local = 60000.0 / gap if gap > 0 else bpm
        tempo = int(round((local if abs(local / bpm - 1) < 0.08 else bpm) * 100)) if bpm else 0
        body += struct.pack(">HHI", n, tempo, int(round(t)))
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

def _mono(w: np.ndarray, top: int) -> tuple[np.ndarray, np.ndarray]:
    """Height (0..top) and 'whiteness' (0..7, more treble = whiter) per column."""
    f = w.astype(np.float32)
    height = np.clip(f.max(axis=1) / 255.0 * top, 0, top).astype(np.uint8)
    white = np.clip(f[:, 2] / (f.sum(axis=1) + 1e-6) * 14.0, 0, 7).astype(np.uint8)
    return height, white


def _rgb(w: np.ndarray, levels: int) -> np.ndarray:
    """Pioneer RGB mapping: lows red, mids green, highs blue."""
    f = w.astype(np.float32)
    norm = f / (f.max(axis=1, keepdims=True) + 1e-6)
    return np.clip(np.round(norm * levels), 0, levels).astype(np.uint8)


def _wave_tags(wave: np.ndarray) -> tuple[bytes, bytes, bytes, bytes, bytes, bytes, bytes]:
    n = len(wave)
    prev400 = resample(wave, 400)
    h, wh = _mono(prev400, 31)
    pwav = _tag(b"PWAV", struct.pack(">II", 400, 0x10000), ((wh << 5) | h).tobytes())
    h, _ = _mono(resample(wave, 100), 15)
    pwv2 = _tag(b"PWV2", struct.pack(">II", 100, 0x10000), h.tobytes())

    h, wh = _mono(wave, 31)
    pwv3 = _tag(b"PWV3", struct.pack(">III", 1, n, 0x960000), ((wh << 5) | h).tobytes())

    p1200 = resample(wave, 1200)
    hgt = (p1200.max(axis=1).astype(np.uint16) * 127 // 255).astype(np.uint8)
    rgb = _rgb(p1200, 127)
    pwv4_body = np.column_stack([hgt, hgt, hgt, rgb[:, 0], rgb[:, 1], rgb[:, 2]]).astype(np.uint8).tobytes()
    pwv4 = _tag(b"PWV4", struct.pack(">III", 6, 1200, 0), pwv4_body)

    rgb = _rgb(wave, 7).astype(np.uint16)
    hh = (wave.max(axis=1).astype(np.uint16) * 31 // 255)
    words = (rgb[:, 0] << 13) | (rgb[:, 1] << 10) | (rgb[:, 2] << 7) | (hh << 2)
    pwv5 = _tag(b"PWV5", struct.pack(">III", 2, n, 0x960305), words.astype(">u2").tobytes())

    def three(w):  # byte order: mid, high, low
        s = (w.astype(np.uint16) * 127 // 255).astype(np.uint8)
        return np.column_stack([s[:, 1], s[:, 2], s[:, 0]]).tobytes()

    pwv6 = _tag(b"PWV6", struct.pack(">II", 3, 1200), three(p1200))
    pwv7 = _tag(b"PWV7", struct.pack(">III", 3, n, 0x960000), three(wave))
    return pwav, pwv2, pwv3, pwv4, pwv5, pwv6, pwv7


# Phrase kinds for the "high" mood (dance music): 1 intro, 2 up, 3 down, 5 chorus, 6 outro.
PHRASE_KINDS = {"Intro": 1, "Verse": 2, "Build": 2, "Drop": 5, "Breakdown": 3, "Outro": 6}


def _phrases(phrases: list[dict], first_beat_ms: float, bpm: float, n_beats: int) -> bytes:
    """PSSI song structure (unmasked, mood 'high'): what CDJ-3000s draw as phrase lanes."""
    beat_ms = 60000.0 / bpm
    body = b""
    for i, p in enumerate(phrases, 1):
        beat = int(round((p["start_ms"] - first_beat_ms) / beat_ms)) + 1
        body += struct.pack(">HHHxBxBxBHHHxBxBH", i, max(1, beat), PHRASE_KINDS.get(p["label"], 2),
                            0, 0, 0, 0, 0, 0, 0, 0, 0)
    head = struct.pack(">IHH6xH2xBx", 24, len(phrases), 1, n_beats, 0)
    return _tag(b"PSSI", head, body)


def build(track_path: str, beats: list[tuple[int, float]], bpm: float, wave: np.ndarray,
          cues: list[Cue], vbr: list[int] | None, phrases: list[dict] | None = None,
          first_beat_ms: float = 0.0) -> tuple[bytes, bytes, bytes]:
    """Return (DAT, EXT, 2EX) file contents for one track."""
    pwav, pwv2, pwv3, pwv4, pwv5, pwv6, pwv7 = _wave_tags(wave)
    path, grid = _path(track_path), _grid(beats, bpm)
    hot, mem = _cues(cues, True), _cues(cues, False)
    dat = _file([path, _vbr(vbr), grid, pwav, pwv2, hot, mem])
    ext_tags = [path, pwv3, hot, mem, _cues2(cues, True), _cues2(cues, False), pwv5, pwv4]  # rekordbox's order
    if phrases and bpm > 0:
        ext_tags.append(_phrases(phrases, first_beat_ms, bpm, len(beats)))
    ext = _file(ext_tags)
    ex2 = _file([path, pwv7, pwv6])
    return dat, ext, ex2
