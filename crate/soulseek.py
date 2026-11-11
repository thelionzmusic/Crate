"""Soulseek, through slskd (a Labs experiment, off unless switched on in Settings).

slskd (https://github.com/slskd/slskd, AGPL-3.0) is an open-source Soulseek client. It does
the network side: your account, searching and transfers. Crate drives it over its local REST
API, then picks finished downloads up into the library and analyses them like any new track.

By default Crate runs slskd itself (Host): the official release is fetched from slskd's own
GitHub on first use, unmodified, and configured entirely through its environment: your login,
a fresh API key every launch, localhost only, no sharing scan. It stops when Crate does.
Anyone already running slskd can point Crate at it instead.

Results are ranked for DJ use: lossless first, then 320 kbps, then the sharer most likely
to deliver quickly (a free upload slot, a short queue, a fast connection).
"""
from __future__ import annotations

import io
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import zipfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path, PureWindowsPath

AUDIO = {"mp3", "flac", "wav", "aiff", "aif", "m4a", "alac"}
LOSSLESS = {"flac", "wav", "aiff", "aif", "alac"}
DONE_OK = "Completed, Succeeded"


class SlskdError(RuntimeError):
    pass


class Slskd:
    def __init__(self, url: str, api_key: str, timeout: float = 8.0):
        self.base = url.rstrip("/") + "/api/v0"
        self.key, self.timeout = api_key, timeout

    def _call(self, method: str, path: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"X-API-Key": self.key, "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise SlskdError("slskd turned the API key down. Check it matches the one in slskd's settings") from None
            if e.code == 409:
                raise SlskdError("Soulseek isn't connected yet. Check your username and password in Settings, or give it a moment") from None
            raise SlskdError(f"slskd answered {e.code} to {path}") from None
        except (urllib.error.URLError, OSError):
            raise SlskdError("Couldn't reach slskd. Is it running, and is the address right?") from None
        return json.loads(raw) if raw.strip() else None

    # ---- the calls Crate uses
    def status(self) -> dict:
        s = self._call("GET", "/server") or {}
        return {"connected": bool(s.get("isConnected")), "logged_in": bool(s.get("isLoggedIn")),
                "connecting": bool(s.get("isConnecting") or s.get("isLoggingIn")), "user": s.get("username")}

    def search(self, text: str) -> str:
        sid = str(uuid.uuid4())
        self._call("POST", "/searches", {"id": sid, "searchText": text, "fileLimit": 2000, "filterResponses": True,
                                          "responseLimit": 200, "searchTimeout": 15000, "minimumResponseFileCount": 1})
        return sid

    def results(self, sid: str) -> dict:
        st = self._call("GET", f"/searches/{sid}") or {}
        responses = self._call("GET", f"/searches/{sid}/responses") or []
        return {"done": bool(st.get("isComplete")), "groups": rank(responses)}

    def download(self, user: str, filename: str, size: int) -> None:
        self._call("POST", f"/transfers/downloads/{urllib.parse.quote(user)}", [{"filename": filename, "size": size}])

    def transfers(self) -> list[dict]:
        out = []
        for u in self._call("GET", "/transfers/downloads") or []:
            for d in u.get("directories", []):
                for f in d.get("files", []):
                    out.append({"id": f.get("id"), "user": u.get("username"), "filename": f.get("filename"), "size": f.get("size", 0),
                                "state": f.get("state", ""), "percent": round(f.get("percentComplete", 0.0), 1),
                                "speed": f.get("averageSpeed", 0.0), "reason": why(f.get("state", ""), f.get("exception"))})
        return out

    def downloads_dir(self) -> Path | None:
        """Where slskd saves files, from its own options."""
        try:
            o = self._call("GET", "/options") or {}
        except SlskdError:
            return None
        d = (o.get("directories") or {}).get("downloads")
        return Path(d) if d else None


def why(state: str, exception: str | None) -> str:
    """A failed transfer, in plain words. '' while it's fine."""
    if not state.startswith("Completed") or state.endswith("Succeeded"):
        return ""
    ex = (exception or "").strip().rstrip(".")
    low = ex.lower()
    if "Cancelled" in state:
        return "Cancelled"
    if "Rejected" in state:
        if "not shared" in low or "file not" in low:
            return "The sharer doesn't have that file any more"
        if "banned" in low:
            return "The sharer has blocked you"
        if "too many" in low or "limit" in low:
            return f"The sharer's limit is reached ({ex}). Try another version"
        return f"The sharer refused it{f' ({ex})' if ex else ''}"
    if "TimedOut" in state:
        return "The sharer stopped responding"
    if any(k in low for k in ("connect", "unreachable", "refused", "closed", "reset")):
        return "Couldn't reach the sharer. They may be offline or behind a firewall"
    return ex or "Something went wrong on the sharer's side"


# ---- ranking
def _name(remote: str) -> str:
    return PureWindowsPath(remote.replace("/", "\\")).name  # Soulseek paths are Windows-style


def _key(remote: str) -> str:
    """Group the same track across sharers: lowercase, no track number, extension or punctuation."""
    stem = _name(remote).rsplit(".", 1)[0].lower()
    stem = re.sub(r"^\s*(\d{1,3}|[a-d]\d)\s*[-._)\s]\s*", "", stem)
    stem = re.sub(r"\[[^\]]*\]|\{[^}]*\}", "", stem)
    return re.sub(r"[^a-z0-9]+", " ", stem).strip()


def quality(f: dict) -> tuple[int, str]:
    """(score, label) for a file: lossless > 320 > V0 > the rest."""
    ext = (f.get("extension") or _name(f["filename"]).rsplit(".", 1)[-1]).lower().lstrip(".")
    br = f.get("bitRate") or 0
    if ext in LOSSLESS:
        depth = f.get("bitDepth")
        return 100, f"{'AIFF' if ext in ('aif', 'aiff') else ext.upper()}{f' {depth}-bit' if depth else ''}"
    if ext in ("mp3", "m4a"):
        if br >= 315:
            return 80, f"{ext.upper()} 320"
        if br >= 240:
            return 60, f"{ext.upper()} {br}"
        return 20 if br else 40, f"{ext.upper()} {br}" if br else ext.upper()
    return 10, ext.upper()


def rank(responses: list[dict]) -> list[dict]:
    """Group files by track; each group lists its sources best first."""
    groups: dict[str, dict] = {}
    for r in responses:
        speed, free, queue = r.get("uploadSpeed", 0), bool(r.get("hasFreeUploadSlot")), r.get("queueLength", 0)
        for f in r.get("files", []):
            name = _name(f.get("filename", ""))
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            if ext not in AUDIO or f.get("isLocked"):
                continue
            q, label = quality(f)
            # quality first, then who'll actually deliver: a free slot, a short queue, a fast line
            score = q * 1000 + (300 if free else 0) - min(queue, 50) * 4 + min(speed / 1e6, 10) * 10
            src = {"user": r.get("username"), "filename": f["filename"], "name": name, "size": f.get("size", 0),
                   "length": f.get("length"), "quality": label, "lossless": q >= 100, "free": free,
                   "queue": queue, "speed": speed, "score": round(score, 1)}
            g = groups.setdefault(_key(f["filename"]), {"key": _key(f["filename"]), "sources": []})
            g["sources"].append(src)
    out = []
    for g in groups.values():
        g["sources"].sort(key=lambda s: -s["score"])
        best = g["sources"][0]
        out.append({"key": g["key"], "title": best["name"].rsplit(".", 1)[0], "best": best, "count": len(g["sources"]),
                    "sources": g["sources"][:60]})
    out.sort(key=lambda g: (-g["best"]["score"] - min(g["count"], 20) * 15))  # widely shared tracks are usually the real thing
    return out[:80]


# ---- picking finished downloads up into the library
class Importer:
    """Remembers which finished downloads Crate already took, so each is added once."""

    def __init__(self):
        self.taken: set[str] = set()
        self.lock = threading.Lock()

    def finished(self, client: Slskd, transfers: list[dict]) -> dict[str, dict]:
        """{local path: transfer} for downloads that just finished and haven't been imported yet."""
        new = [t for t in transfers if t["state"] == DONE_OK and t["id"] not in self.taken]
        if not new:
            return {}
        root = client.downloads_dir()
        out = {}
        with self.lock:
            for t in new:
                p = locate(root, t["filename"])
                if p:
                    self.taken.add(t["id"])
                    out[str(p)] = t
        return out


def locate(root: Path | None, remote: str) -> Path | None:
    """slskd saves into <downloads>/<the sharer's folder name>/<file>; fall back to a search."""
    if not root or not root.is_dir():
        return None
    parts = PureWindowsPath(remote.replace("/", "\\")).parts
    direct = root / parts[-2] / parts[-1] if len(parts) >= 2 else root / parts[-1]
    if direct.is_file():
        return direct
    return next((p for p in root.rglob(parts[-1]) if p.is_file()), None)


# ---- running slskd for you
RELEASES = "https://api.github.com/repos/slskd/slskd/releases/latest"


def _rid() -> str:
    """slskd's name for this platform in its release files."""
    import platform
    arm = platform.machine().lower() in ("arm64", "aarch64")
    if os.name == "nt":
        return "win-arm64" if arm else "win-x64"
    if sys.platform == "darwin":
        return "osx-arm64" if arm else "osx-x64"
    return "linux-arm64" if arm else "linux-x64"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Host:
    """slskd as a child of Crate. state: off, installing, starting, running, error."""

    def __init__(self, home: Path):
        self.root = home / "slskd"
        self.proc: subprocess.Popen | None = None
        self.port, self.key = 0, ""
        self.state, self.error, self.progress = "off", "", 0.0
        self.lock = threading.Lock()
        self._job = None

    @property
    def exe(self) -> Path:
        override = os.environ.get("CRATE_SLSKD")  # tests, or a copy you built yourself
        return Path(override) if override else self.root / "bin" / ("slskd.exe" if os.name == "nt" else "slskd")

    def installed(self) -> bool:
        return self.exe.is_file()

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def client(self) -> Slskd:
        return Slskd(f"http://127.0.0.1:{self.port}", self.key)

    # first use: the official release, straight from slskd's GitHub
    def install(self) -> None:
        self.state, self.progress = "installing", 0.0
        local = os.environ.get("CRATE_SLSKD_ZIP")  # tests: a release zip already on disk
        if local:
            blob = Path(local).read_bytes()
        else:
            req = urllib.request.Request(RELEASES, headers={"Accept": "application/vnd.github+json", "User-Agent": "Crate"})
            with urllib.request.urlopen(req, timeout=15) as r:
                rel = json.load(r)
            want = f"-{_rid()}.zip"
            asset = next((a for a in rel.get("assets", []) if a["name"].endswith(want)), None)
            if not asset or not asset["browser_download_url"].startswith("https://github.com/slskd/slskd/"):
                raise SlskdError(f"slskd {rel.get('tag_name', '')} has no download for this computer")
            req = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "Crate"})
            parts, got = [], 0
            with urllib.request.urlopen(req, timeout=60) as r:
                total = int(r.headers.get("Content-Length") or asset.get("size") or 1)
                while chunk := r.read(1 << 20):
                    parts.append(chunk); got += len(chunk); self.progress = got / total
            blob = b"".join(parts)
        dest = self.root / "bin.new"
        shutil.rmtree(dest, ignore_errors=True)
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            for n in z.namelist():
                if n.startswith("/") or ".." in Path(n).parts:
                    raise SlskdError("The slskd download has unsafe paths")
            z.extractall(dest)
        exe = dest / self.exe.name
        if not exe.is_file():
            raise SlskdError("The slskd download didn't contain the program")
        if os.name != "nt":
            exe.chmod(0o755)
        shutil.rmtree(self.root / "bin", ignore_errors=True)
        dest.replace(self.root / "bin")

    def start(self, user: str, password: str, downloads: Path) -> None:
        """(Re)start slskd signed in as `user`; returns once its API answers."""
        with self.lock:
            self.stop()
            try:
                if not self.installed():
                    self.install()
                self.state, self.error = "starting", ""
                inc = self.root / "incomplete"
                for d in (self.root / "data", downloads, inc):
                    d.mkdir(parents=True, exist_ok=True)  # slskd won't start if they're missing
                self.port, self.key = _free_port(), secrets.token_hex(24)
                env = {**os.environ,
                       "SLSKD_APP_DIR": str(self.root / "data"),
                       "SLSKD_SLSK_USERNAME": user, "SLSKD_SLSK_PASSWORD": password,
                       "SLSKD_HTTP_IP_ADDRESS": "127.0.0.1", "SLSKD_HTTP_PORT": str(self.port), "SLSKD_NO_HTTPS": "true",
                       # the status and options calls need the administrator role; the key only works from this computer
                       "SLSKD_API_KEY": f"role=Administrator;cidr=127.0.0.1/32,::1/128;{self.key}",
                       "SLSKD_DOWNLOADS_DIR": str(downloads), "SLSKD_INCOMPLETE_DIR": str(inc),
                       "SLSKD_NO_VERSION_CHECK": "true", "SLSKD_NO_SHARE_SCAN": "true"}
                log = open(self.root / "slskd.log", "a", encoding="utf-8")
                self.proc = subprocess.Popen([str(self.exe)], env=env, cwd=str(self.exe.parent), stdin=subprocess.DEVNULL,
                                             stdout=log, stderr=log, creationflags=0x08000000 if os.name == "nt" else 0)
                self._job = _kill_with_crate(self.proc)
                c = self.client()
                for _ in range(120):  # about a minute on a slow first start
                    if self.proc.poll() is not None:
                        raise SlskdError("slskd stopped while starting. Details are in slskd.log in Crate's folder")
                    try:
                        c.status(); self.state = "running"; return
                    except SlskdError:
                        time.sleep(0.5)
                raise SlskdError("slskd didn't start in time")
            except Exception as e:
                self.stop()
                self.state, self.error = "error", str(e)

    def stop(self) -> None:
        p, self.proc = self.proc, None
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        if self.state != "error":
            self.state = "off"


def _kill_with_crate(proc: subprocess.Popen):
    """Windows: put slskd in a job that closes with Crate, so it can't outlive a crash."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32

        class Basic(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("r", "w", "o", "rb", "wb", "ob")]

        class Extended(ctypes.Structure):
            _fields_ = [("Basic", Basic), ("Io", IoCounters), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        job = k32.CreateJobObjectW(None, None)
        info = Extended()
        info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))  # 9: extended limit information
        k32.AssignProcessToJobObject(job, wintypes.HANDLE(int(proc._handle)))
        return job  # kept open for Crate's lifetime; Windows closes it, and slskd with it, when Crate exits
    except Exception:
        return None


# ---- batches: a CSV of tracks, searched and downloaded one after another
import csv  # noqa: E402

FILLER = {"the", "a", "an", "and", "feat", "ft", "featuring", "vs", "x", "original", "mix", "radio", "edit", "version"}
VARIANT = {"remix", "rmx", "edit", "live", "acoustic", "instrumental", "acapella", "dub", "bootleg", "vip", "rework", "extended"}


def _words(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", s.lower().replace("&", " and ")))


def parse_csv(text: str) -> list[dict]:
    """[{artist, title, query}] from a CSV: artist/title columns (any common naming, Spotify
    exports included), a single search column, or headerless artist,title rows."""
    text = text.lstrip("﻿")
    rows = list(csv.reader(text.splitlines()))
    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        return []
    head = [c.strip().lower() for c in rows[0]]
    find = lambda *names: next((i for i, c in enumerate(head) if c in names), None)  # noqa: E731
    a = find("artist", "artists", "artist name", "artist name(s)", "artist(s)")
    t = find("title", "track", "track name", "name", "song", "song name")
    q = find("query", "search", "search term")
    body = rows[1:] if (a is not None or t is not None or q is not None) else rows
    out = []
    for r in body:
        cell = lambda i: r[i].strip() if i is not None and i < len(r) else ""  # noqa: E731
        if q is not None:
            query = cell(q); artist, title = "", query
        elif a is not None or t is not None:
            artist, title = cell(a), cell(t)
        elif len(r) >= 2:
            artist, title = r[0].strip(), r[1].strip()
        else:
            artist, title = "", r[0].strip()
        artist = re.split(r"\s*[,;]\s*", artist)[0] if artist else ""  # "A, B" from Spotify: the lead artist searches best
        title = re.sub(r"\s*-\s*(\d{4} )?remaster(ed)?.*$", "", title, flags=re.I)  # "- 2011 Remaster" never matches files
        if title:
            out.append({"artist": artist, "title": title, "query": f"{artist} {title}".strip()})
    return out


def choose(groups: list[dict], artist: str, title: str) -> list[dict]:
    """Copies of this exact track, best first: the title's words must be there, the artist's
    mostly, and no remix/edit/live the CSV didn't ask for."""
    tw = _words(title) - FILLER or _words(title)
    aw = _words(artist) - FILLER
    asked = _words(title) & VARIANT
    picks = []
    for g in groups:
        for s in g["sources"]:
            have = _words(s["filename"].replace("\\", " "))
            if len(tw & have) < max(1, round(len(tw) * 0.8)):
                continue
            if aw and len(aw & have) < max(1, len(aw) // 2):
                continue
            extra = (have & VARIANT) - asked - (_words(artist) & VARIANT)
            picks.append((s["score"] - len(extra) * 40000, s))  # an unasked-for remix only if nothing else exists
    picks.sort(key=lambda p: -p[0])
    return [s for _, s in picks]


class Batch:
    """Works through a list in the background. The app supplies three callables:
    client() -> Slskd, queue(src, playlist_id), sync() -> transfers with track_id/analysed."""

    def __init__(self, name: str, items: list[dict], playlist: int | None, playlist_name: str | None):
        self.name, self.playlist, self.playlist_name = name, playlist, playlist_name
        self.items = [{**it, "state": "waiting", "detail": "", "track_id": None, "cands": [], "tries": 0, "key": None} for it in items]
        self.cancelled = False
        self.running = False

    def snapshot(self) -> dict:
        strip = lambda it: {k: it[k] for k in ("artist", "title", "state", "detail", "track_id")}  # noqa: E731
        done = sum(it["state"] in ("done", "not found", "failed", "skipped") for it in self.items)
        return {"name": self.name, "playlist": self.playlist_name, "running": self.running, "done": done,
                "total": len(self.items), "items": [strip(it) for it in self.items]}

    def run(self, client, queue, sync, pause: float = 2.0) -> None:
        self.running = True
        try:
            for it in self.items:
                if self.cancelled:
                    break
                self._find(it, client, queue)
                self._follow(sync, queue)
                time.sleep(pause)  # Soulseek's server dislikes rapid-fire searches
            while not self.cancelled and any(it["state"] in ("downloading", "retrying") for it in self.items):
                time.sleep(2)
                self._follow(sync, queue)
        finally:
            for it in self.items:
                if it["state"] in ("waiting", "searching"):
                    it["state"] = "skipped"
            self.running = False

    def _find(self, it: dict, client, queue) -> None:
        it["state"] = "searching"
        try:
            c = client()
            sid = c.search(it["query"])
            deadline, res = time.time() + 25, {"done": False, "groups": []}
            while time.time() < deadline and not res["done"]:
                time.sleep(1)
                res = c.results(sid)
            it["cands"] = choose(res["groups"], it["artist"], it["title"])[:6]
        except SlskdError as e:
            it["state"], it["detail"] = "failed", str(e)
            return
        if not it["cands"]:
            it["state"], it["detail"] = "not found", "Nobody is sharing a copy that matches"
            return
        self._start(it, queue)

    def _start(self, it: dict, queue) -> None:
        src = it["cands"][it["tries"]]
        it["tries"] += 1
        it["key"] = f'{src["user"]}|{src["filename"]}'
        it["state"] = "downloading" if it["tries"] == 1 else "retrying"
        it["detail"] = f'{src["quality"]} from {src["user"]}'
        try:
            queue(src, self.playlist)
        except SlskdError as e:
            it["state"], it["detail"] = "failed", str(e)

    def _follow(self, sync, queue) -> None:
        try:
            transfers = {f'{t["user"]}|{t["filename"]}': t for t in sync()}
        except SlskdError:
            return
        for it in self.items:
            t = transfers.get(it["key"]) if it["key"] else None
            if not t or it["state"] not in ("downloading", "retrying"):
                continue
            if t.get("track_id") and t.get("analysed"):
                it["state"], it["track_id"] = "done", t["track_id"]
                it["detail"] = f"In {self.playlist_name}" if self.playlist_name else "In your library"
            elif t["reason"]:
                if it["tries"] < len(it["cands"]) and "Cancelled" not in t["state"]:
                    self._start(it, queue)  # next copy
                else:
                    it["state"], it["detail"] = "failed", t["reason"]
            elif t["state"] == "InProgress":
                it["detail"] = f'{t["percent"]:.0f}% from {t["user"]}'
