"""ffmpeg/ffprobe bridge: tag probing and decoding to float32 PCM."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from functools import cache
from pathlib import Path

import numpy as np

# Formats any current Pioneer player can play (per-player limits live in export.profiles).
AUDIO_EXT = {".mp3", ".wav", ".aif", ".aiff", ".flac", ".m4a", ".aac", ".mp4"}
LOSSY = {"mp3", "aac"}
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


@cache
def tool(name: str) -> str:
    """Locate a bundled binary (bin/ next to the exe) before falling back to PATH."""
    exe = name + (".exe" if os.name == "nt" else "")
    roots = [Path(getattr(sys, "_MEIPASS", "")), Path(sys.executable).parent, Path(__file__).resolve().parent.parent]
    for root in roots:
        for cand in (root / "bin" / exe, root / exe):
            if cand.is_file():
                return str(cand)
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f"{exe} not found. Put it in the 'bin' folder next to Crate.")
    return found


def run(args: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, check=True, creationflags=NO_WINDOW, **kw)


def _int(value, default=0) -> int:
    m = re.match(r"\s*(\d+)", str(value or ""))
    return int(m.group(1)) if m else default


def probe(path: str | Path) -> dict:
    """Read stream properties and tags. Raises on unreadable or audio-less files."""
    out = run([tool("ffprobe"), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]).stdout
    info = json.loads(out)
    fmt, streams = info.get("format", {}), info.get("streams", [])
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if a is None:
        raise ValueError("no audio stream")
    tags = {k.lower(): v for k, v in (a.get("tags") or {}).items()}
    tags.update({k.lower(): v for k, v in (fmt.get("tags") or {}).items()})

    codec = a.get("codec_name", "")
    codec = "pcm" if codec.startswith("pcm_") else codec
    if codec in LOSSY:
        depth = 16
    else:
        depth = _int(a.get("bits_per_raw_sample")) or _int(a.get("bits_per_sample")) or 16
        if a.get("codec_name", "").startswith("pcm_f"):
            depth = 32
    sr = _int(a.get("sample_rate"), 44100)
    ch = _int(a.get("channels"), 2)
    duration = float(fmt.get("duration") or a.get("duration") or 0)
    bitrate = _int(a.get("bit_rate")) or _int(fmt.get("bit_rate"))
    bitrate = bitrate // 1000 if bitrate else (sr * depth * ch // 1000)
    if codec == "pcm" or codec in ("flac", "alac"):
        bitrate = sr * depth * ch // 1000  # CDJs show uncompressed rate for lossless

    p = Path(path)
    return {
        "title": tags.get("title") or p.stem,
        "artist": tags.get("artist") or tags.get("album_artist") or "",
        "album": tags.get("album") or "",
        "genre": tags.get("genre") or "",
        "label": tags.get("publisher") or tags.get("label") or tags.get("organization") or "",
        "remixer": tags.get("remixer") or tags.get("mixartist") or "",
        "comment": tags.get("comment") or tags.get("description") or "",
        "year": _int(tags.get("date") or tags.get("year")),
        "track_no": _int(tags.get("track")),
        "duration": duration,
        "sample_rate": sr,
        "bit_depth": depth,
        "channels": ch,
        "bitrate": bitrate,
        "codec": codec,
        "has_art": int(any(s.get("disposition", {}).get("attached_pic") for s in streams)),
        "size": p.stat().st_size,
        "mtime": p.stat().st_mtime,
    }


def decode(path: str | Path, sr: int = 44100) -> np.ndarray:
    """Decode to (n, 2) float32. MP3s keep encoder padding so timing matches what CDJs play."""
    cmd = [tool("ffmpeg"), "-v", "error", "-nostdin"]
    if Path(path).suffix.lower() == ".mp3":
        cmd += ["-flags2", "+skip_manual"]
    cmd += ["-i", str(path), "-map", "0:a:0", "-f", "f32le", "-ac", "2", "-ar", str(sr), "-"]
    return np.frombuffer(run(cmd).stdout, dtype=np.float32).reshape(-1, 2)


def extract_art(path: str | Path, dest: Path, size: int) -> bool:
    """Write the embedded cover as a square JPEG. Returns False if there is none."""
    try:
        run([tool("ffmpeg"), "-v", "error", "-y", "-i", str(path), "-map", "0:v:0", "-frames:v", "1",
             "-vf", f"scale={size}:{size}:force_original_aspect_ratio=increase,crop={size}:{size}",
             "-q:v", "3", str(dest)])
        return dest.is_file()
    except subprocess.CalledProcessError:
        return False
