"""Builds Crate's icons from the two SVG sources in this folder.

    logo.svg        the mark: an orange hexagon with a crate rim and two decks cut out of it
    logo-small.svg  the art used at 32 px and below (the same today; kept for a simpler cut later)

Writes crate/web/icon.png (256 px) and crate/web/icon.ico (16 to 256 px, small art below 48).
Needs Playwright's Chromium:  python brand/logo.py
"""
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
WEB = HERE.parent / "crate" / "web"
SIZES = [16, 24, 32, 48, 64, 128, 256]


def render(svg: Path, size: int, page) -> Image.Image:
    page.set_viewport_size({"width": size, "height": size})
    page.set_content(f'<body style="margin:0;background:transparent">{svg.read_text().replace("<svg ", f"<svg width=\"{size}\" height=\"{size}\" ", 1)}</body>')
    out = HERE / f".tmp-{size}.png"
    page.screenshot(path=str(out), omit_background=True)
    im = Image.open(out).convert("RGBA")
    out.unlink()
    return im


def main() -> None:
    with sync_playwright() as p:
        page = p.chromium.launch().new_page()
        art = {s: render(HERE / ("logo-small.svg" if s <= 32 else "logo.svg"), s, page) for s in SIZES}
    art[256].save(WEB / "icon.png")
    art[256].save(WEB / "icon.ico", sizes=[(s, s) for s in SIZES], append_images=[art[s] for s in SIZES if s != 256])
    print("wrote icon.png and icon.ico")


if __name__ == "__main__":
    main()
