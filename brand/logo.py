"""Builds Crate's icons from the two SVG sources in this folder.

    logo.svg        the mark: a hexagonal C in three parallel bands, like records filed in a crate
    logo-small.svg  the art used at 32 px and below (the same today; kept for a simpler cut later)

Writes crate/web/icon.png (256 px), crate/web/icon.ico (16 to 256 px, small art below 48) and
crate/web/splash.html (what the window shows for the moment Crate takes to start).
Needs Playwright's Chromium:  python brand/logo.py
"""
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
WEB = HERE.parent / "crate" / "web"
SIZES = [16, 24, 32, 48, 64, 128, 256]
SPLASH = """<!doctype html><html><head><meta charset="utf-8"><title>Crate</title><style>
html,body{margin:0;height:100%;background:#101113;color:#8e8e93;font:500 13px system-ui,"Segoe UI",sans-serif;overflow:hidden}
body{display:grid;place-items:center;user-select:none}
main{display:grid;justify-items:center;gap:14px;animation:in .35s ease-out both}
h1{margin:0;color:#f2f2f7;font:600 22px system-ui,"Segoe UI",sans-serif;letter-spacing:-.01em}
i{display:block;width:120px;height:2px;background:#2a2a2e;border-radius:1px;overflow:hidden}
i::after{content:"";display:block;width:40%;height:100%;background:#ff9f0a;animation:run 1.1s ease-in-out infinite}
@keyframes run{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
@keyframes in{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){main,i::after{animation:none}}
</style></head><body><main>{mark}<h1>Crate</h1><i></i></main></body></html>
"""


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
    mark = (HERE / "logo.svg").read_text().replace('<svg ', '<svg width="112" height="112" ', 1)
    (WEB / "splash.html").write_text(SPLASH.replace("{mark}", mark), "utf-8")
    print("wrote icon.png, icon.ico and splash.html")


if __name__ == "__main__":
    main()
