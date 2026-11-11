"""Soulseek ranking and file pickup (Labs): grouping, quality order, locating downloads."""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from crate import soulseek  # noqa: E402


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} {name:<34} {detail}")
    return 0 if ok else 1


def main() -> int:
    f = lambda name, **k: {"filename": f"@@share\\Fisher\\{name}", "size": 10_000_000, **k}  # noqa: E731
    responses = [
        {"username": "slow", "hasFreeUploadSlot": False, "queueLength": 30, "uploadSpeed": 100_000,
         "files": [f("01 - Fisher - Losing It.flac", extension="flac"), f("cover.jpg")]},
        {"username": "fast", "hasFreeUploadSlot": True, "queueLength": 0, "uploadSpeed": 5_000_000,
         "files": [f("Fisher - Losing It.mp3", extension="mp3", bitRate=320), f("Fisher_-_Losing_It.flac", extension="flac")]},
        {"username": "meh", "hasFreeUploadSlot": True, "queueLength": 0, "uploadSpeed": 5_000_000,
         "files": [f("Fisher - Losing It [128].mp3", extension="mp3", bitRate=128), f("Other Track.mp3", extension="mp3", bitRate=320, isLocked=True)]},
    ]
    groups = soulseek.rank(responses)
    fails = check("same track grouped across names", len(groups) == 1 and groups[0]["count"] == 4, f"{len(groups)} group, {groups[0]['count']} copies")
    order = [(s["user"], s["quality"]) for s in groups[0]["sources"]]
    fails += check("lossless first, free slot beats queue", order[0] == ("fast", "FLAC") and order[1][1] == "FLAC" and order[-1][1] == "MP3 128", str(order))
    fails += check("no artwork or locked files", all(s["name"].endswith((".flac", ".mp3")) for s in groups[0]["sources"]))
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "Fisher").mkdir()
        (root / "Fisher" / "Fisher - Losing It.flac").write_bytes(b"x")
        (root / "elsewhere").mkdir()
        (root / "elsewhere" / "Moved.mp3").write_bytes(b"x")
        a = soulseek.locate(root, "@@share\\Music\\Fisher\\Fisher - Losing It.flac")
        b = soulseek.locate(root, "@@share\\Other\\Moved.mp3")
        fails += check("finds finished downloads", a and a.name == "Fisher - Losing It.flac" and b and b.parent.name == "elsewhere")
    print("all passed" if not fails else f"{fails} failed")
    return fails


if __name__ == "__main__":
    sys.exit(main())
