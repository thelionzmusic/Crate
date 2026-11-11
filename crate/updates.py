"""Check GitHub releases for a newer Crate and fetch its update file.

Works when the repository is public. For a private repository GitHub answers 404 to
anonymous requests, and Crate simply reports nothing new.
"""
from __future__ import annotations

import json
import re
import urllib.request

from . import __version__

REPO = "thelionzmusic/Crate"
API = f"https://api.github.com/repos/{REPO}/releases/latest"


def _v(s: str) -> tuple:
    return tuple(int(p) for p in re.findall(r"\d+", s or ""))


def check(timeout: float = 6.0, strict: bool = False) -> dict | None:
    """{version, notes, url, update_asset} if a newer release exists, else None.
    strict: raise when GitHub can't be reached, instead of quietly reporting nothing new."""
    req = urllib.request.Request(API, headers={"Accept": "application/vnd.github+json", "User-Agent": "Crate-updater"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            rel = json.load(r)
    except Exception as e:
        if strict:
            raise ConnectionError("Couldn't reach GitHub to check for updates. Are you online?") from e
        return None
    version = rel.get("tag_name", "").lstrip("v")
    if _v(version) <= _v(__version__):
        return None
    asset = next((a["browser_download_url"] for a in rel.get("assets", []) if a["name"].endswith("-update.zip")), None)
    if not asset:  # a release still building has no update file yet
        return None
    return {"version": version, "notes": rel.get("body") or "", "url": rel.get("html_url"), "update_asset": asset}


def download(url: str, timeout: float = 60.0) -> bytes:
    if not url.startswith(f"https://github.com/{REPO}/"):
        raise ValueError("Updates only come from Crate's own releases.")
    req = urllib.request.Request(url, headers={"User-Agent": "Crate-updater"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()
