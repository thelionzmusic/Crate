"""Cover art for tracks that have none, looked up by artist and title in Apple's public
iTunes catalogue (no account needed). Kept beside the library; your files are never changed."""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request

SEARCH = "https://itunes.apple.com/search?"
SIZE = 600


def _clean(s: str) -> str:
    """Titles without the noise stores don't use: (Original Mix), [Free DL], feat. ..."""
    s = re.sub(r"[\(\[][^\)\]]*(mix|edit|dl|download|remaster|version|vip)[^\)\]]*[\)\]]", "", s or "", flags=re.I)
    return re.sub(r"\s+(feat\.?|ft\.?)\s.*$", "", s, flags=re.I).strip()


def find(artist: str, title: str, timeout: float = 8.0) -> bytes | None:
    """A square JPEG of the release's cover, or None when nothing matches the artist."""
    term = f"{_clean(artist)} {_clean(title)}".strip()
    if not term:
        return None
    q = urllib.parse.urlencode({"term": term, "entity": "song", "limit": 8})
    with urllib.request.urlopen(SEARCH + q, timeout=timeout) as r:  # noqa: S310 (fixed https host)
        results = json.loads(r.read().decode("utf-8")).get("results", [])
    want = _clean(artist).lower()
    hit = next((x for x in results if want and want.split(",")[0].strip() in x.get("artistName", "").lower()), None)
    if not hit or not hit.get("artworkUrl100"):
        return None
    url = hit["artworkUrl100"].replace("100x100bb", f"{SIZE}x{SIZE}bb")
    with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310
        return r.read()
