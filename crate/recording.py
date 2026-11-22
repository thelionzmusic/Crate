"""Mix recordings: where they go, and the WAV file the in-page engine streams into (the
native engine writes its own). 32-bit float stereo, header sizes filled in on stop."""
from __future__ import annotations

import datetime as dt
import struct
import threading
from pathlib import Path


def folder() -> Path:
    f = Path.home() / "Music" / "Crate Recordings"
    f.mkdir(parents=True, exist_ok=True)
    return f


def new_path() -> Path:
    return folder() / f"Crate mix {dt.datetime.now():%Y-%m-%d %H%M}.wav"


def _header(rate: int, data: int) -> bytes:
    return (b"RIFF" + struct.pack("<I", 36 + data) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 3, 2, rate, rate * 8, 8, 32)
            + b"data" + struct.pack("<I", data))


class Writer:
    """Chunks of interleaved float32 stereo, appended as they arrive."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.f = None
        self.path: Path | None = None
        self.rate = 0
        self.bytes = 0

    def start(self, rate: int) -> Path:
        with self.lock:
            self._close()
            self.path, self.rate, self.bytes = new_path(), int(rate), 0
            self.f = open(self.path, "wb")  # noqa: SIM115 (open until stop)
            self.f.write(_header(self.rate, 0))
            return self.path

    def write(self, chunk: bytes) -> None:
        with self.lock:
            if self.f:
                self.f.write(chunk)
                self.bytes += len(chunk)

    def stop(self) -> dict:
        with self.lock:
            out = {"path": str(self.path), "seconds": round(self.bytes / 8 / max(1, self.rate), 1)} if self.f else {}
            self._close()
            return out

    def _close(self) -> None:
        if self.f:
            self.f.seek(0)
            self.f.write(_header(self.rate, min(self.bytes, 0xFFFFFFF0)))
            self.f.close()
            self.f = None
