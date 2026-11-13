"""A pretend CDJ-3000 on localhost: announces itself and plays track 1 on air.
    python tests/web/sim_cdj.py [seconds]"""
import socket
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_prolink import status  # noqa: E402

from crate import prolink  # noqa: E402

tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
end = time.time() + float(sys.argv[1] if len(sys.argv) > 1 else 120)
n = 0
while time.time() < end:
    if n % 10 == 0:
        tx.sendto(prolink.keepalive("CDJ-3000", 1, b"\x00\x11\x22\x33\x44\x55", socket.inet_aton("127.0.0.1")), ("127.0.0.1", prolink.PORT_ANNOUNCE))
    tx.sendto(status(1, 1, bpm=124.0), ("127.0.0.1", prolink.PORT_STATUS))
    n += 1
    time.sleep(0.15)
