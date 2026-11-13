"""Builds Crate's icons from the two SVG sources in this folder.

    logo.svg        the mark: a hexagonal C in three parallel bands, like records filed in a crate
    logo-small.svg  the art used at 32 px and below (the same today; kept for a simpler cut later)

Writes crate/web/icon.png (256 px), crate/web/icon.ico (16 to 256 px, small art below 48) and
crate/web/splash.html (what the window shows for the moment Crate takes to start), and
brand/splash.png (the still the .exe shows before anything has loaded).
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
main{display:grid;justify-items:center;gap:16px}
svg rect{fill:transparent}
/* the three bands of the C draw in, outermost first, then settle with a soft glow */
svg path{stroke-dasharray:1;stroke-dashoffset:1;animation:draw .9s cubic-bezier(.65,0,.35,1) forwards}
svg path:nth-of-type(2){animation-delay:.14s} svg path:nth-of-type(3){animation-delay:.28s}
svg{animation:glow 2.4s ease-in-out 1.2s infinite alternate}
h1{margin:0;color:#f2f2f7;font:600 22px system-ui,"Segoe UI",sans-serif;letter-spacing:-.01em;opacity:0;animation:up .5s ease-out .75s forwards}
i{display:block;width:120px;height:2px;background:#2a2a2e;border-radius:1px;overflow:hidden;opacity:0;animation:up .4s ease-out 1s forwards}
i::after{content:"";display:block;width:40%;height:100%;background:#ff9f0a;animation:run 1.1s ease-in-out 1s infinite}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes run{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
@keyframes glow{from{filter:drop-shadow(0 0 0 rgba(255,159,10,0))}to{filter:drop-shadow(0 0 18px rgba(255,159,10,.28))}}
@media (prefers-reduced-motion:reduce){svg path{stroke-dashoffset:0;animation:none}svg,i::after{animation:none}h1,i{opacity:1;animation:none}}
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
    # pathLength=1 lets the splash draw each band in with a dash animation, whatever its real length
    mark = (HERE / "logo.svg").read_text().replace('<svg ', '<svg width="128" height="128" ', 1).replace("<path ", '<path pathLength="1" ')
    (WEB / "splash.html").write_text(SPLASH.replace("{mark}", mark), "utf-8")
    # the still the .exe shows the instant it's opened (PyInstaller's splash), as the animated
    # splash looks once it has settled, so the hand-over to the window is seamless
    with sync_playwright() as p:
        page = p.chromium.launch().new_page(viewport={"width": 360, "height": 260}, device_scale_factor=1)
        page.goto((WEB / "splash.html").as_uri())
        page.add_style_tag(content="*{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important} i{visibility:hidden}")
        page.wait_for_timeout(300)
        page.screenshot(path=str(HERE / "splash.png"))
    print("wrote icon.png, icon.ico, splash.html and splash.png")


if __name__ == "__main__":
    main()
