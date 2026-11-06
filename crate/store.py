"""Record stores: search links, and the downloads folder watcher that imports purchases."""
from __future__ import annotations

import os
import threading
import time
import webbrowser
from pathlib import Path
from urllib.parse import quote_plus, urlparse

from . import audio

STORES = {
    "Beatport": "https://www.beatport.com/search?q={q}",
    "Bandcamp": "https://bandcamp.com/search?q={q}",
    "Traxsource": "https://www.traxsource.com/search?term={q}",
    "Juno": "https://www.junodownload.com/search/?q%5Ball%5D%5B%5D={q}",
}
ALLOWED = {urlparse(u).hostname for u in STORES.values()} | {"github.com"}


def links(artist: str, title: str) -> dict[str, str]:
    q = quote_plus(" ".join(p for p in (artist, title) if p).strip())
    return {name: url.format(q=q) for name, url in STORES.items()}


def open_url(url: str) -> None:
    """Open a store page in the system browser. Only store hosts, only https."""
    u = urlparse(url)
    if u.scheme != "https" or u.hostname not in ALLOWED:
        raise ValueError("Crate only opens record store links.")
    if os.name == "nt":
        os.startfile(url)  # noqa: S606  (default browser, not the app window)
    else:
        webbrowser.open(url)


class DownloadsWatcher:
    """Imports new audio files that land in the downloads folder, once they've finished
    downloading (size unchanged across two checks)."""

    def __init__(self, folder: Path, on_new, interval: float = 8.0):
        self.folder, self.on_new, self.interval = Path(folder), on_new, interval
        self._seen: dict[str, int] = {}
        self._stop = threading.Event()
        self._baseline = True

    def start(self) -> "DownloadsWatcher":
        threading.Thread(target=self._run, daemon=True).start()
        return self

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        pending: dict[str, int] = {}
        while not self._stop.is_set():
            try:
                found = {str(p): p.stat().st_size for p in self.folder.iterdir()
                         if p.is_file() and p.suffix.lower() in audio.AUDIO_EXT and not p.name.startswith(".")}
            except OSError:
                found = {}
            if self._baseline:  # what's already there isn't a new purchase
                self._seen, self._baseline = found, False
            else:
                ready = [p for p, size in found.items() if p not in self._seen and pending.get(p) == size and size > 0]
                pending = {p: size for p, size in found.items() if p not in self._seen}
                if ready:
                    for p in ready:
                        self._seen[p] = found[p]
                        pending.pop(p, None)
                    self.on_new(ready)
            self._stop.wait(self.interval)
