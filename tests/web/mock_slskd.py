"""A stand-in for slskd's REST API, for testing Crate's Downloads tab without the network.

Searches answer with a few sharers offering the same tracks in different qualities;
downloads progress over a few seconds and then write a real audio file into the downloads
folder, the way slskd lays it out (<downloads>/<sharer's folder>/<file>).

    python tests/web/mock_slskd.py <port> <downloads dir> <api key>
"""
import json
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from synth import track, write  # noqa: E402

PORT, ROOT, KEY = int(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
SEARCHES: dict = {}
TRANSFERS: list = []
LOCK = threading.Lock()


def catalogue(q: str) -> list[dict]:
    words = q.lower()
    tracks = [("Fisher", "Losing It (Extended Mix)", 125), ("Fisher", "You Little Beauty", 126), ("Chris Lake", "Turn Off The Lights", 126)]
    hits = [t for t in tracks if any(w in f"{t[0]} {t[1]}".lower() for w in words.split())]
    users = [("crate_digger", True, 0, 4_000_000), ("vinylvault", False, 6, 900_000), ("slowpoke", True, 0, 120_000)]
    out = []
    for name, free, queue, speed in users:
        files = []
        for i, (artist, title, _) in enumerate(hits):
            base = f"@@music\\{artist}\\{artist} - {title}"
            if name == "crate_digger":
                files.append({"filename": f"{base}.flac", "size": 48_000_000, "extension": "flac", "bitDepth": 16, "sampleRate": 44100, "length": 360})
            elif name == "vinylvault":
                files.append({"filename": f"{base}.mp3", "size": 14_000_000, "extension": "mp3", "bitRate": 320, "length": 360})
            else:
                files.append({"filename": f"{base}.mp3", "size": 6_000_000, "extension": "mp3", "bitRate": 128, "length": 360})
                files.append({"filename": f"{base}.jpg", "size": 90_000, "extension": "jpg"})
        if files:
            out.append({"username": name, "files": files, "fileCount": len(files), "hasFreeUploadSlot": free,
                        "queueLength": queue, "uploadSpeed": speed, "lockedFileCount": 0, "lockedFiles": [], "token": 1})
    return out


def run_transfer(t: dict) -> None:
    for pct in (0, 15, 40, 70, 100):
        time.sleep(0.6)
        with LOCK:
            t.update(state="InProgress" if pct < 100 else t["state"], percentComplete=float(pct), bytesTransferred=t["size"] * pct // 100, averageSpeed=2_500_000.0)
    parts = t["filename"].split("\\")
    dest = ROOT / parts[-2] / parts[-1]
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".wav")
    write(tmp, track(125, 0.2, "A", True, seconds=60))
    tmp.replace(dest)  # the extension lies, as files on Soulseek sometimes do; the content is real audio
    with LOCK:
        t.update(state="Completed, Succeeded", percentComplete=100.0)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, body=None):
        raw = json.dumps(body).encode() if body is not None else b""
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers()
        self.wfile.write(raw)

    def _auth(self):
        if self.headers.get("X-API-Key") != KEY:
            self._json(401, {"error": "unauthorised"}); return False
        return True

    def do_GET(self):
        if not self._auth():
            return
        p = self.path.split("?")[0]
        if p == "/api/v0/server":
            return self._json(200, {"isConnected": True, "isLoggedIn": True, "username": "sean_test", "state": "Connected, LoggedIn"})
        if p == "/api/v0/options":
            return self._json(200, {"directories": {"downloads": str(ROOT), "incomplete": str(ROOT / "incomplete")}})
        if p.startswith("/api/v0/searches/"):
            sid, *rest = p[len("/api/v0/searches/"):].split("/")
            s = SEARCHES.get(sid)
            if not s:
                return self._json(404)
            done = time.time() - s["at"] > 2.0  # results trickle in, then the search completes
            if rest == ["responses"]:
                return self._json(200, s["responses"] if time.time() - s["at"] > 0.8 else s["responses"][:1])
            return self._json(200, {"id": sid, "searchText": s["q"], "isComplete": done, "state": "Completed" if done else "InProgress",
                                    "responseCount": len(s["responses"]), "fileCount": 0, "lockedFileCount": 0})
        if p == "/api/v0/transfers/downloads":
            with LOCK:
                users = {}
                for t in TRANSFERS:
                    d = t["filename"].rsplit("\\", 1)[0]
                    users.setdefault(t["username"], {}).setdefault(d, []).append(dict(t))
            return self._json(200, [{"username": u, "directories": [{"directory": d, "fileCount": len(fs), "files": fs} for d, fs in dirs.items()]}
                                    for u, dirs in users.items()])
        self._json(404)

    def do_POST(self):
        if not self._auth():
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"null")
        if self.path == "/api/v0/searches":
            SEARCHES[body["id"]] = {"q": body["searchText"], "at": time.time(), "responses": catalogue(body["searchText"])}
            return self._json(200, {"id": body["id"], "searchText": body["searchText"], "isComplete": False})
        if self.path.startswith("/api/v0/transfers/downloads/"):
            user = self.path.rsplit("/", 1)[1]
            for f in body:
                t = {"id": str(uuid.uuid4()), "username": user, "filename": f["filename"], "size": f["size"], "state": "Queued, Remotely",
                     "percentComplete": 0.0, "bytesTransferred": 0, "averageSpeed": 0.0, "direction": "Download"}
                with LOCK:
                    TRANSFERS.append(t)
                threading.Thread(target=run_transfer, args=(t,), daemon=True).start()
            return self._json(201)
        self._json(404)


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    print(f"mock slskd on {PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
