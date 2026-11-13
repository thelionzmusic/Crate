"""Distortion-free level matching.

Gain is pure scaling with the true peak kept under the ceiling (decided in analysis),
so nothing is ever limited or clipped. How it is applied depends on the format:

* WAV / AIFF / FLAC / ALAC: rewritten sample-for-sample with the gain applied (16-bit
  output gets TPDF dither). Sample count and start are unchanged, so grids and cues hold.
* MP3: the global_gain field of every granule is shifted in 1.5 dB steps, the same
  lossless trick as mp3gain. Audio data and frame positions are untouched.
* AAC: cannot be changed losslessly, so it is copied as-is and left to the trim.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from .. import audio

MP3_STEP_DB = 1.5
_BR = {3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
       2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]}
_SR = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


# ---- MP3 -------------------------------------------------------------------

def _id3_end(data: bytes | bytearray) -> int:
    if data[:3] != b"ID3" or len(data) < 10:
        return 0
    size = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]
    return 10 + size + (10 if data[5] & 0x10 else 0)


def mp3_frames(data: bytes | bytearray):
    """Yield (offset, length, mpeg1, mono, crc) for each valid Layer III frame."""
    pos, end = _id3_end(data), len(data)
    while pos + 4 <= end:
        h = int.from_bytes(data[pos:pos + 4], "big")
        ver, layer, br_i, sr_i = (h >> 19) & 3, (h >> 17) & 3, (h >> 12) & 15, (h >> 10) & 3
        if (h >> 21) != 0x7FF or ver == 1 or layer != 1 or br_i in (0, 15) or sr_i == 3:
            pos += 1
            continue
        br = _BR[3 if ver == 3 else 2][br_i] * 1000
        sr = _SR[ver][sr_i]
        length = (144 if ver == 3 else 72) * br // sr + ((h >> 9) & 1)
        if pos + length > end:
            break
        # Require the next frame to sync too, so stray 0xFFE bytes in tags aren't taken as frames.
        nxt = pos + length
        if nxt + 2 <= end and (data[nxt] != 0xFF or data[nxt + 1] & 0xE0 != 0xE0):
            pos += 1
            continue
        yield pos, length, ver == 3, ((h >> 6) & 3) == 3, not ((h >> 16) & 1)
        pos += length


def _gain_bits(mpeg1: bool, mono: bool) -> list[int]:
    """Bit positions of every global_gain field, relative to the start of side info."""
    nch = 1 if mono else 2
    if mpeg1:
        base, block, gr = 9 + (5 if mono else 3) + 4 * nch, 59, 2
    else:
        base, block, gr = 8 + (1 if mono else 2), 63, 1
    return [base + (g * nch + c) * block + 21 for g in range(gr) for c in range(nch)]


def _get(buf: bytearray, bit: int) -> int:
    i, s = bit >> 3, bit & 7
    return ((buf[i] << 8 | buf[i + 1]) >> (8 - s)) & 0xFF


def _set(buf: bytearray, bit: int, v: int) -> None:
    i, s = bit >> 3, bit & 7
    word = (buf[i] << 8 | buf[i + 1]) & ~(0xFF << (8 - s)) | (v << (8 - s))
    buf[i], buf[i + 1] = (word >> 8) & 0xFF, word & 0xFF


def _crc16(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x8005) if crc & 0x8000 else crc << 1
        crc &= 0xFFFF
    return crc


def mp3_samples(data: bytes | bytearray) -> int:
    """Decoded length in samples (audio frames x 1152, or 576 for MPEG-2), which rekordbox puts
    in the analysis file. The Xing/Info header frame carries no audio, so it isn't counted."""
    total = 0
    for pos, _, mpeg1, mono, crc in mp3_frames(data):
        side = pos + 4 + (2 if crc else 0)
        if any(_get(data, side * 8 + b) for b in _gain_bits(mpeg1, mono)):
            total += 1152 if mpeg1 else 576
    return total


def mp3_apply(src: Path, dst: Path, gain_db: float, headroom_db: float | None = None) -> float:
    """Shift global_gain on every granule. Returns the gain actually applied.

    Rounds to the nearest 1.5 dB step, but never above `headroom_db` (the room left
    under the true-peak ceiling)."""
    data = bytearray(src.read_bytes())
    steps = round(gain_db / MP3_STEP_DB)
    limit = gain_db if headroom_db is None else headroom_db
    while steps > 0 and steps * MP3_STEP_DB > limit + 1e-9:
        steps -= 1
    frames = []
    lo, hi = 255, 0
    for pos, _, mpeg1, mono, crc in mp3_frames(data):
        side = pos + 4 + (2 if crc else 0)
        bits = _gain_bits(mpeg1, mono)
        vals = [_get(data, side * 8 + b) for b in bits]
        if not any(vals):  # Xing/Info header frame
            continue
        frames.append((pos, side, bits, crc, 17 if (mpeg1 and mono) or (not mpeg1 and not mono) else 32 if mpeg1 else 9))
        lo, hi = min(lo, min(vals)), max(hi, max(vals))
    if frames:  # never let a field wrap: that would be the distortion we promise to avoid
        steps = max(min(steps, 255 - hi), -lo)
    if steps:
        for pos, side, bits, crc, side_len in frames:
            for b in bits:
                v = _get(data, side * 8 + b)
                if v:
                    _set(data, side * 8 + b, v + steps)
            if crc:
                c = _crc16(bytes(data[pos + 2:pos + 4]) + bytes(data[side:side + side_len]))
                data[pos + 4:pos + 6] = c.to_bytes(2, "big")
    dst.write_bytes(data)
    return steps * MP3_STEP_DB


# ---- PCM / lossless ---------------------------------------------------------

_PCM = {"wav": {16: "pcm_s16le", 24: "pcm_s24le", 32: "pcm_s24le"},
        "aiff": {16: "pcm_s16be", 24: "pcm_s24be", 32: "pcm_s24be"}}


def lossless_apply(src: Path, dst: Path, gain_db: float, container: str, bits: int,
                   sample_rate: int | None = None) -> float:
    """Re-render PCM with gain (and optionally a new rate) into `container`."""
    bits = 16 if bits <= 16 else 24
    filters = [f"volume={gain_db:.4f}dB:precision=double"] if abs(gain_db) >= 0.005 else []
    if sample_rate:
        # swr with a long windowed-sinc filter: transparent, and in every ffmpeg build
        filters.append(f"aresample={sample_rate}:filter_size=128:phase_shift=10:cutoff=0.975")
    if bits == 16:
        filters.append("aresample=osf=s16:dither_method=triangular")
    args = [audio.tool("ffmpeg"), "-v", "error", "-nostdin", "-y", "-i", str(src), "-map", "0:a:0"]
    if filters:
        args += ["-af", ",".join(filters)]
    if container in _PCM:
        args += ["-c:a", _PCM[container][bits]]
        if container == "aiff":
            args += ["-map", "0:v?", "-c:v", "copy", "-write_id3v2", "1"]
    elif container == "flac":
        args += ["-map", "0:v?", "-c:v", "copy", "-c:a", "flac", "-compression_level", "5",
                 "-sample_fmt", "s16" if bits == 16 else "s32", "-bits_per_raw_sample", str(bits)]
    elif container == "alac":
        args += ["-map", "0:v?", "-c:v", "copy", "-c:a", "alac",
                 "-sample_fmt", "s16p" if bits == 16 else "s32p", "-bits_per_raw_sample", str(bits)]
    else:
        raise ValueError(container)
    args += ["-map_metadata", "0", "-f", {"alac": "ipod", "aiff": "aiff"}.get(container, container), str(dst)]
    audio.run(args)
    return gain_db


def container_of(path: Path, codec: str) -> str:
    ext = path.suffix.lower()
    if ext == ".mp3":
        return "mp3"
    if ext in (".aif", ".aiff"):
        return "aiff"
    if ext == ".wav":
        return "wav"
    if ext == ".flac":
        return "flac"
    return "alac" if codec == "alac" else "aac"


def render(src: Path, dst: Path, gain_db: float, codec: str, bits: int,
           to_container: str | None = None, sample_rate: int | None = None,
           headroom_db: float | None = None) -> float:
    """Write `src` to `dst` with gain applied as losslessly as the format allows.

    Returns the gain actually applied (MP3 rounds down to 1.5 dB steps, AAC is 0)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    src_c = container_of(src, codec)
    out_c = to_container or src_c
    try:
        if out_c == "mp3" and src_c == "mp3":
            if abs(gain_db) >= MP3_STEP_DB / 2:
                applied = mp3_apply(src, tmp, gain_db, headroom_db)
            else:
                shutil.copyfile(src, tmp)
                applied = 0.0
        elif out_c == "aac" or (abs(gain_db) < 0.005 and out_c == src_c and not sample_rate and bits <= 24):
            shutil.copyfile(src, tmp)
            applied = 0.0
        else:
            applied = lossless_apply(src, tmp, gain_db, out_c, bits, sample_rate)
        tmp.replace(dst)
        return applied
    finally:
        tmp.unlink(missing_ok=True)
