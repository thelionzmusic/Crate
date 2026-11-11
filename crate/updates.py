"""Check GitHub releases for a newer Crate and fetch its update file.

The latest version is read from github.com's own "latest release" redirect, which has no
hourly limit. GitHub's API (60 anonymous requests an hour per home connection, easily used
up by a day of restarts) is only asked for the release notes, and only as a nice-to-have.
Failures say what actually went wrong, and land in crate.log.
"""
from __future__ import annotations

import json
import logging
import re
import socket
import ssl
import urllib.error
import urllib.request

from . import __version__

REPO = "thelionzmusic/Crate"
LATEST = f"https://github.com/{REPO}/releases/latest"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
UA = {"User-Agent": "Crate-updater"}


def _v(s: str) -> tuple:
    return tuple(int(p) for p in re.findall(r"\d+", s or ""))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None  # we want the Location header, not the page it points to


def _latest_tag(timeout: float) -> str:
    """'v1.2.3' from github.com/<repo>/releases/latest -> .../releases/tag/v1.2.3"""
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        opener.open(urllib.request.Request(LATEST, headers=UA, method="HEAD"), timeout=timeout)
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            m = re.search(r"/releases/tag/([^/?#]+)", e.headers.get("Location", ""))
            if m:
                return m.group(1)
        raise
    raise ConnectionError("GitHub didn't say which release is the latest")


def _notes(tag: str, timeout: float = 4.0) -> str:
    try:
        req = urllib.request.Request(API, headers={**UA, "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            rel = json.load(r)
        return (rel.get("body") or "") if rel.get("tag_name") == tag else ""
    except Exception:
        return ""  # notes are optional; the API's hourly limit must never block an update


def explain(e: BaseException) -> str:
    """Why a request to GitHub failed, in plain words."""
    inner = getattr(e, "reason", e)
    if isinstance(e, urllib.error.HTTPError):
        if e.code in (403, 429):
            return "GitHub is limiting requests from your connection for a while. Try again in an hour"
        if e.code == 404:
            return "Crate's releases page wasn't found on GitHub"
        return f"GitHub answered with an error ({e.code}). Try again shortly"
    if isinstance(inner, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(inner):
        return ("Windows couldn't verify GitHub's security certificate. Antivirus that inspects web traffic, "
                "or a work or school network, usually causes this")
    if isinstance(inner, (socket.timeout, TimeoutError)) or "timed out" in str(inner):
        return "GitHub took too long to answer. Check your connection and try again"
    if isinstance(inner, socket.gaierror):
        return "Your computer couldn't find GitHub. Are you online?"
    if isinstance(inner, (ConnectionRefusedError, ConnectionResetError)):
        return "The connection to GitHub was blocked or dropped. A firewall or VPN may be in the way"
    return f"Couldn't reach GitHub: {inner}"


def check(timeout: float = 8.0, strict: bool = False) -> dict | None:
    """{version, notes, url, update_asset} if a newer release exists, else None.
    strict: raise (with the real reason) when GitHub can't be reached, instead of quietly
    reporting nothing new."""
    try:
        tag = _latest_tag(timeout)
    except Exception as e:
        logging.warning("update check failed: %r", e)
        if strict:
            raise ConnectionError(explain(e)) from None
        return None
    version = tag.lstrip("v")
    if _v(version) <= _v(__version__):
        return None
    return {"version": version, "notes": _notes(tag), "url": f"https://github.com/{REPO}/releases/tag/{tag}",
            "update_asset": f"https://github.com/{REPO}/releases/download/{tag}/Crate-{version}-update.zip"}


def download(url: str, timeout: float = 60.0) -> bytes:
    if not url.startswith(f"https://github.com/{REPO}/"):
        raise ValueError("Updates only come from Crate's own releases.")
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:  # the release exists but its files are still uploading
            raise ConnectionError("That update is still being published. Try again in a few minutes") from None
        raise ConnectionError(explain(e)) from None
    except (urllib.error.URLError, OSError) as e:
        raise ConnectionError(explain(e)) from None
