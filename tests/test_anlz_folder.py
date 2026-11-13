"""Players find a track's analysis by hashing its path on the stick, ignoring the library.
These pairs come from a real rekordbox export; anlz.folder must give the same folders."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from crate.export import anlz  # noqa: E402

REKORDBOX = {
    "/Contents/Rusko/UnknownAlbum/Cockney Thug (Original Mix).mp3": "/PIONEER/USBANLZ/P00D/00001DC9",
    "/Contents/DJ Fresh/Gold Dust Part 2/DJ Fresh - Gold Dust (Flux Pavilion Remix).mp3": "/PIONEER/USBANLZ/P022/0002E534",
    "/Contents/UnknownArtist/UnknownAlbum/Lionz - If Only (Original Mix).wav": "/PIONEER/USBANLZ/P02E/0000F1EC",
    "/Contents/Flume/Skin_ The Remixes/14 Say It (feat. Tove Lo) [SG Lewis Remix].mp3": "/PIONEER/USBANLZ/P05C/000156F0",
    "/Contents/LYNY/EDM Singles (24-25.07.25)/LYNY - Section.mp3": "/PIONEER/USBANLZ/P076/0001FB66",
}
bad = {p: (anlz.folder(p), want) for p, want in REKORDBOX.items() if anlz.folder(p) != want}
for p, (got, want) in bad.items():
    print("FAIL", p, got, "!=", want)
print("all passed" if not bad else "FAILURES")
sys.exit(1 if bad else 0)
