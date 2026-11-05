"""Crate mark: three record sleeves leaning in a crate, in the waveform's low/mid/high colours.
Renders the app icon (.ico, .png) and the inline SVG used by the UI from one geometry."""
from PIL import Image, ImageDraw

S = 1024
SLEEVES = [  # (pivot x, angle deg, colour) back to front
    (438, -17, (58, 123, 255)),
    (506, -7, (255, 179, 64)),
    (578, 3, (245, 245, 247)),
]
W, H, R, BASE = 404, 540, 46, 760
LIP = (196, 688, 828, 842, 40)


def tile() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / S
        c = tuple(int(a + (b - a) * t) for a, b in zip((44, 44, 49), (22, 22, 25)))
        gd.line([(0, y), (S, y)], fill=c + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=228, fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def sleeve(px: int, angle: float, colour) -> Image.Image:
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([px - W // 2, BASE - H, px + W // 2, BASE + 60], radius=R, fill=colour + (255,))
    # a soft shadow edge on the right so overlapping sleeves separate
    return layer.rotate(-angle, resample=Image.BICUBIC, center=(px, BASE))


def render() -> Image.Image:
    img = tile()
    for px, ang, col in SLEEVES:
        shadow = sleeve(px + 10, ang, (0, 0, 0))
        shadow.putalpha(shadow.getchannel("A").point(lambda a: a * 0.35))
        img.alpha_composite(shadow)
        img.alpha_composite(sleeve(px, ang, col))
    lip = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(lip)
    x0, y0, x1, y1, r = LIP
    d.rounded_rectangle([x0, y0 + 14, x1, y1 + 14], radius=r, fill=(0, 0, 0, 90))
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=(52, 52, 58, 255))
    d.rounded_rectangle([x0 + 4, y0 + 2, x1 - 4, y0 + 10], radius=4, fill=(255, 255, 255, 26))
    img.alpha_composite(lip)
    return img


def svg() -> str:
    parts = []
    for px, ang, col in SLEEVES:
        hexc = "#%02x%02x%02x" % col
        parts.append(f'<rect x="{px - W // 2}" y="{BASE - H}" width="{W}" height="{H + 60}" rx="{R}" '
                     f'fill="{hexc}" transform="rotate({ang} {px} {BASE})"/>')
    x0, y0, x1, y1, r = LIP
    return (f'<svg viewBox="0 0 {S} {S}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
            f'<rect width="{S}" height="{S}" rx="228" fill="#232327"/>{"".join(parts)}'
            f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{r}" fill="#34343a"/></svg>')


if __name__ == "__main__":
    big = render()
    big.save("crate-icon-1024.png")
    big.resize((256, 256), Image.LANCZOS).save("../crate/web/icon.png")
    big.save("../crate/web/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    open("mark.svg", "w").write(svg())
    print(svg())
