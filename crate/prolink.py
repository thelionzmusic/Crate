"""Follow the CDJs over Pro DJ Link: what each deck has loaded, whether it's playing and on
air, and a log of the set as it happens.

Crate joins the network as a virtual player (device 7 or above, so it never takes a real
deck's number) by broadcasting a keep-alive every 1.5 s. Players then send it their status
on port 50002. Nothing is ever sent that changes a player.

Tracks map straight back to the library because a stick exported by Crate uses Crate's own
track ids as its rekordbox ids. Layouts follow Deep Symmetry's dysentery analysis.
"""
from __future__ import annotations

import ipaddress
import socket
import struct
import threading
import time
import uuid
from dataclasses import dataclass, field

MAGIC = b"Qspt1WmJOL"
PORT_ANNOUNCE, PORT_BEAT, PORT_STATUS = 50000, 50001, 50002
KEEPALIVE, CDJ_STATUS = 0x06, 0x0A
SLOTS = {0: "none", 1: "CD", 2: "SD", 3: "USB", 4: "rekordbox"}
PLAYED_AFTER_S = 30.0       # on air this long and it goes in the set log
FORGET_DEVICE_S = 6.0       # a device that stops announcing has left


def keepalive(name: str, number: int, mac: bytes, ip: bytes) -> bytes:
    """A player's announcement, as beat-link sends it for a virtual CDJ."""
    p = bytearray(0x36)
    p[0:10], p[0x0A] = MAGIC, KEEPALIVE
    p[0x0C:0x0C + 20] = name.encode("ascii", "replace")[:20].ljust(20, b"\0")
    p[0x20], p[0x21] = 0x01, 0x02
    p[0x22:0x24] = struct.pack(">H", 0x36)
    p[0x24], p[0x25] = number, 0x01
    p[0x26:0x2C], p[0x2C:0x30] = mac[:6], ip[:4]
    p[0x30], p[0x34] = 0x01, 0x01  # one peer seen; device type: player
    return bytes(p)


def parse_keepalive(d: bytes) -> dict | None:
    if len(d) < 0x30 or d[:10] != MAGIC or d[0x0A] != KEEPALIVE:
        return None
    return {"number": d[0x24], "name": d[0x0C:0x20].split(b"\0")[0].decode("ascii", "replace"),
            "ip": socket.inet_ntoa(d[0x2C:0x30]), "kind": d[0x34] if len(d) > 0x34 else 0}


def parse_status(d: bytes) -> dict | None:
    """A CDJ status packet: what's loaded, from where, and what the deck is doing."""
    if len(d) < 0xA4 or d[:10] != MAGIC or d[0x0A] != CDJ_STATUS:
        return None
    flags = d[0x89]
    pitch = struct.unpack_from(">I", d, 0x8C)[0] & 0xFFFFFF
    bpm = struct.unpack_from(">H", d, 0x92)[0]
    return {"number": d[0x21], "source": d[0x28], "slot": SLOTS.get(d[0x29], "?"), "track_type": d[0x2A],
            "track": struct.unpack_from(">I", d, 0x2C)[0], "mode": d[0x7B],
            "playing": bool(flags & 0x40), "master": bool(flags & 0x20), "synced": bool(flags & 0x10),
            "on_air": bool(flags & 0x08), "bpm": None if bpm == 0xFFFF else bpm / 100,
            "pitch": round((pitch - 0x100000) * 100 / 0x100000, 2),
            "beat": struct.unpack_from(">I", d, 0xA0)[0]}


@dataclass
class Deck:
    number: int
    track: int = 0
    slot: str = "none"
    playing: bool = False
    on_air: bool = True
    bpm: float | None = None
    pitch: float = 0.0
    master: bool = False
    seen: float = 0.0
    aired: float = 0.0          # seconds this track has played on air
    started: float = 0.0        # wall clock when it first went on air
    logged: bool = False


@dataclass
class Link:
    """Runs while "Follow the CDJs" is on. on_play(track_id, deck, started) fires once per
    track that plays on air long enough to count."""
    on_play: callable = lambda *_: None
    name: str = "Crate"
    devices: dict = field(default_factory=dict)       # number -> {name, ip, kind, seen}
    decks: dict = field(default_factory=dict)         # number -> Deck
    log: list = field(default_factory=list)
    error: str | None = None

    def __post_init__(self):
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._socks: list[socket.socket] = []
        self.number = 0
        self.local_ip: str | None = None
        self.mixer = False

    # ---- lifecycle ----------------------------------------------------------------
    def start(self) -> "Link":
        self._stop.clear()
        try:
            for port in (PORT_ANNOUNCE, PORT_STATUS):
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                s.bind(("", port))
                s.settimeout(0.5)
                self._socks.append(s)
        except OSError as e:
            self.stop()
            self.error = (f"Port {port} is in use. Close rekordbox (or anything else on the DJ Link network) "
                          f"on this computer, then turn this on again" if getattr(e, "winerror", 0) == 10048 or e.errno in (98, 48)
                          else f"Couldn't listen on the network: {e}")
            return self
        self.error = None
        for s, handler in zip(self._socks, (self._announce, self._status)):
            threading.Thread(target=self._listen, args=(s, handler), daemon=True).start()
        threading.Thread(target=self._announce_loop, daemon=True).start()
        return self

    def stop(self) -> None:
        self._stop.set()
        for s in self._socks:
            try:
                s.close()
            except OSError:
                pass
        self._socks.clear()

    @property
    def running(self) -> bool:
        return bool(self._socks) and not self._stop.is_set()

    # ---- receiving ------------------------------------------------------------------
    def _listen(self, s: socket.socket, handler) -> None:
        while not self._stop.is_set():
            try:
                data, addr = s.recvfrom(2048)
            except (socket.timeout, TimeoutError):
                continue
            except OSError:
                return
            try:
                handler(data, addr)
            except Exception:  # one odd packet never stops the link
                continue

    def _announce(self, data: bytes, addr) -> None:
        k = parse_keepalive(data)
        if not k or (self.number and k["number"] == self.number and k["ip"] == self.local_ip):
            return
        with self._lock:
            self.devices[k["number"]] = {**k, "seen": time.monotonic()}
            if k["kind"] == 3 or "DJM" in k["name"].upper():
                self.mixer = True
            if self.local_ip is None:
                self.local_ip = _local_ip_towards(k["ip"])

    def _status(self, data: bytes, addr) -> None:
        st = parse_status(data)
        if not st:
            return
        now = time.monotonic()
        with self._lock:
            d = self.decks.setdefault(st["number"], Deck(st["number"]))
            dt = min(now - d.seen, 1.0) if d.seen else 0.0
            if st["track"] != d.track:
                d.track, d.aired, d.started, d.logged = st["track"], 0.0, 0.0, False
            d.slot, d.playing, d.bpm, d.pitch, d.master = st["slot"], st["playing"], st["bpm"], st["pitch"], st["master"]
            d.on_air = st["on_air"] if self.mixer else True  # without a mixer on the link, playing counts
            d.seen = now
            fire = None
            if d.track and d.playing and d.on_air:
                if not d.started:
                    d.started = time.time()
                d.aired += dt
                if d.aired >= PLAYED_AFTER_S and not d.logged:
                    d.logged = True
                    entry = {"track": d.track, "deck": d.number, "started": d.started}
                    self.log.append(entry)
                    fire = entry
        if fire:
            self.on_play(fire["track"], fire["deck"], fire["started"])

    # ---- sending ----------------------------------------------------------------------
    def _announce_loop(self) -> None:
        time.sleep(2.0)  # hear who's there before choosing a number
        mac = uuid.getnode().to_bytes(6, "big")
        tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        tx.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        try:
            while not self._stop.is_set():
                with self._lock:
                    now = time.monotonic()
                    for n in [n for n, v in self.devices.items() if now - v["seen"] > FORGET_DEVICE_S]:
                        del self.devices[n]
                    if not self.number or self.number in self.devices:
                        self.number = next(n for n in range(7, 16) if n not in self.devices)
                    targets = {v["ip"] for v in self.devices.values()}
                    ip = self.local_ip
                if ip:
                    pkt = keepalive(self.name, self.number, mac, socket.inet_aton(ip))
                    for dest in {_broadcast(ip), *targets}:
                        try:
                            tx.sendto(pkt, (dest, PORT_ANNOUNCE))
                        except OSError:
                            pass
                self._stop.wait(1.5)
        finally:
            tx.close()

    # ---- state for the page -----------------------------------------------------------
    def snapshot(self) -> dict:
        now = time.monotonic()
        with self._lock:
            decks = [{"number": d.number, "track": d.track, "slot": d.slot, "playing": d.playing, "on_air": d.on_air,
                      "bpm": d.bpm, "pitch": d.pitch, "master": d.master, "aired": round(d.aired),
                      "live": now - d.seen < 3} for d in sorted(self.decks.values(), key=lambda d: d.number)]
            return {"running": self.running, "error": self.error, "number": self.number, "mixer": self.mixer,
                    "devices": [{"number": n, "name": v["name"], "ip": v["ip"]} for n, v in sorted(self.devices.items())],
                    "decks": [d for d in decks if d["live"]], "log": list(self.log)}


def _local_ip_towards(ip: str) -> str | None:
    """This computer's address on the interface that reaches `ip` (no packet is sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((ip, PORT_ANNOUNCE))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def _broadcast(ip: str) -> str:
    """DJ Link networks are either self-assigned (169.254/16) or a home router's /24."""
    prefix = 16 if ip.startswith("169.254.") else 24
    return str(ipaddress.ip_network(f"{ip}/{prefix}", strict=False).broadcast_address)
