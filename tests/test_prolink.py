"""Pro DJ Link: a simulated CDJ and mixer on localhost talk to Crate's virtual player.

Checks Crate announces itself with a free player number, reads deck status, and logs a
track to History once it has played on air long enough."""
import socket
import struct
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from crate import prolink  # noqa: E402
from crate.library import Library  # noqa: E402

ok = True


def check(cond, name, detail=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name, detail)
    ok &= bool(cond)


def status(number, track, playing=True, on_air=True, bpm=128.0, slot=3):
    p = bytearray(0x200)  # a CDJ-3000 sized packet
    p[0:10], p[0x0A] = prolink.MAGIC, prolink.CDJ_STATUS
    p[0x0B:0x0B + 8] = b"CDJ-3000"
    p[0x21], p[0x24], p[0x28], p[0x29], p[0x2A] = number, number, number, slot, 1
    p[0x2C:0x30] = struct.pack(">I", track)
    p[0x7B] = 3 if playing else 5
    p[0x89] = (0x40 if playing else 0) | (0x08 if on_air else 0)
    p[0x8C:0x90] = struct.pack(">I", 0x100000 + 0x100000 // 50)  # +2%
    p[0x92:0x94] = struct.pack(">H", int(bpm * 100))
    return bytes(p)


def run():
    prolink.PLAYED_AFTER_S = 1.0
    home = Path(tempfile.mkdtemp())
    lib = Library(home)
    tid = lib.upsert(str(home / "a.mp3"), {"title": "Losing It", "artist": "Fisher", "duration": 300.0})
    played = []
    link = prolink.Link(on_play=lambda t, d, s: (played.append((t, d)), lib.log_live_play(t, s))).start()
    check(link.running, "listening", link.error or "")
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    me = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)  # what Crate announces arrives here too (port 50000 is shared)
    for n, name, kind in ((1, "CDJ-3000", 1), (2, "CDJ-3000", 1), (33, "DJM-V10", 3)):
        tx.sendto(prolink.keepalive(name, n, b"\x00\x11\x22\x33\x44\x55", socket.inet_aton("127.0.0.1"))[:0x34] + bytes([kind, 0]), ("127.0.0.1", prolink.PORT_ANNOUNCE))
    time.sleep(2.6)
    snap = link.snapshot()
    check({d["number"] for d in snap["devices"]} >= {1, 2, 33}, "sees the players and mixer", snap["devices"])
    check(snap["number"] == 7, "takes player number 7", snap["number"])
    check(snap["mixer"], "knows a mixer is on the link")
    # deck 1 plays our track off air, then on air; deck 2 plays something not in the library
    for i in range(30):
        tx.sendto(status(1, tid, on_air=i >= 10), ("127.0.0.1", prolink.PORT_STATUS))
        tx.sendto(status(2, 99999), ("127.0.0.1", prolink.PORT_STATUS))
        time.sleep(0.1)
    snap = link.snapshot()
    d1 = next(d for d in snap["decks"] if d["number"] == 1)
    check(d1["track"] == tid and d1["playing"] and d1["on_air"] and d1["bpm"] == 128.0 and d1["pitch"] == 2.0,
          "reads deck 1", d1)
    check((tid, 1) in played, "logs the track once it's played on air", played)
    check(len(played) == 2 and (99999, 2) in played, "logs each track once, including ones not in the library", played)
    hist = [n for n in lib.nodes() if n["name"].startswith("Live ")]
    check(hist and hist[0]["tracks"] == [tid], "adds it to History > Live", hist)
    t = lib.track(tid)
    check(t["plays"] == 1 and t["last_played"], "counts the play", (t["plays"], t["last_played"]))
    link.stop()
    check(not link.running, "stops")
    me.close()


if __name__ == "__main__":
    run()
    print("all passed" if ok else "FAILURES")
    sys.exit(0 if ok else 1)
