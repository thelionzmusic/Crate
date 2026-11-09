"""The native audio engine (crate-engine): finding it, running it, and feeding it decoded tracks.

The engine is a separate process that talks to the page over a local WebSocket. Crate starts it
on demand, it only accepts Crate's own page, and it quits by itself when Crate does (it watches
its stdin, which closes with us). Tracks reach it as raw 16-bit stereo files decoded by ffmpeg
at the engine's sample rate, cached so reloading a track is instant.
"""
from __future__ import annotations

import logging
import os
import subprocess
import threading
from pathlib import Path

from . import audio

EXE = "crate-engine" + (".exe" if os.name == "nt" else "")
CACHE_KEEP = 12  # decoded tracks kept on disk (about 70 MB each at 48 kHz)


def binary() -> Path | None:
    """The engine shipped in this copy of Crate (an in-app update can bring a newer one)."""
    override = os.environ.get("CRATE_ENGINE")
    cands = [Path(override)] if override else []
    cands.append(Path(__file__).resolve().parent / "bin" / EXE)
    return next((p for p in cands if p.is_file()), None)


class Engine:
    def __init__(self, home: Path):
        self.home = home
        self.proc: subprocess.Popen | None = None
        self._log = None
        self.port = 0
        self._lock = threading.Lock()
        self._decode_lock = threading.Lock()

    def info(self) -> dict:
        return {"available": binary() is not None, "running": self.running, "port": self.port if self.running else 0}

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self, origins: list[str]) -> int:
        """Start the engine if it isn't running; returns its WebSocket port."""
        with self._lock:
            if self.running:
                return self.port
            exe = binary()
            if exe is None:
                raise RuntimeError("The native audio engine isn't installed. Reinstall Crate to get it.")
            cmd = [str(exe), "--port", "0"]
            for o in origins:
                cmd += ["--origin", o]
            if os.environ.get("CRATE_ENGINE_RECORD"):  # tests: capture the silent output to a WAV
                cmd += ["--record", os.environ["CRATE_ENGINE_RECORD"]]
            self._log = self._log or open(self.home / "engine.log", "a", encoding="utf-8")
            self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._log,
                                         text=True, creationflags=audio.NO_WINDOW)
            line = self.proc.stdout.readline().strip()  # "PORT 51234"
            if not line.startswith("PORT "):
                self.stop()
                raise RuntimeError("The native audio engine didn't start. Details are in engine.log")
            self.port = int(line.split()[1])
            logging.info("native engine on port %d", self.port)
            return self.port

    def stop(self) -> None:
        with self._lock:
            p, self.proc, self.port = self.proc, None, 0
        if p is None:
            return
        try:
            p.stdin.close()  # the engine quits when its stdin closes
            p.wait(timeout=3)
        except Exception:
            p.kill()

    def decode(self, path: str, tid: int, rate: int) -> dict:
        """Decode a track to raw 16-bit stereo at `rate`; returns the file and its length in frames."""
        out_dir = self.home / "pcm"
        out_dir.mkdir(exist_ok=True)
        out = out_dir / f"{tid}-{rate}.raw"
        src = Path(path)
        if not src.is_file():
            raise FileNotFoundError("The file is missing or can't be read")
        with self._decode_lock:
            if not out.is_file() or out.stat().st_mtime < src.stat().st_mtime:
                tmp = out.with_suffix(".part")
                audio.run([audio.tool("ffmpeg"), "-v", "error", "-nostdin", "-y", "-i", str(src), "-map", "0:a:0",
                           "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "2", "-ar", str(rate), str(tmp)])
                tmp.replace(out)
                self._prune(out_dir)
            else:
                out.touch()  # most recently used
        return {"path": str(out), "frames": out.stat().st_size // 4}

    @staticmethod
    def _prune(folder: Path) -> None:
        files = sorted(folder.glob("*.raw"), key=lambda p: p.stat().st_mtime, reverse=True)
        for f in files[CACHE_KEEP:]:
            try:
                f.unlink()
            except OSError:
                pass  # in use; next time
