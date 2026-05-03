"""Generate PWA icons. Run: python3 scripts/generate_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG = (15, 23, 42)        # slate-900
ACCENT = (56, 189, 248)  # sky-400
TEXT = (241, 245, 249)   # slate-100


def find_font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ]
    for p in candidates:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def draw_icon(size: int, maskable: bool = False) -> Image.Image:
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)
    # Maskable icons need a 10% safe zone on each side.
    inset = int(size * 0.18) if maskable else int(size * 0.10)

    # Accent rounded rectangle
    radius = int(size * 0.18)
    box = (inset, inset, size - inset, size - inset)
    d.rounded_rectangle(box, radius=radius, fill=BG, outline=ACCENT, width=max(2, size // 64))

    # Sound wave dots top-right
    cx = size - inset - int(size * 0.15)
    cy = inset + int(size * 0.18)
    r = max(2, size // 80)
    for i, alpha in enumerate([1.0, 0.7, 0.45]):
        rr = r + int(size * 0.012 * (i + 1))
        c = tuple(int(BG[k] + (ACCENT[k] - BG[k]) * alpha) for k in range(3))
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline=c, width=max(1, size // 200))

    # "EN" label
    font = find_font(int(size * 0.42))
    text = "EN"
    bbox = d.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = (size - th) // 2 - bbox[1] + int(size * 0.02)
    d.text((tx, ty), text, font=font, fill=TEXT)

    # Underline accent
    bar_y = ty + th + int(size * 0.04)
    bar_w = int(tw * 0.6)
    bar_h = max(3, size // 64)
    d.rounded_rectangle(
        ((size - bar_w) // 2, bar_y, (size + bar_w) // 2, bar_y + bar_h),
        radius=bar_h // 2,
        fill=ACCENT,
    )
    return img


for size in (192, 512):
    draw_icon(size).save(OUT / f"icon-{size}.png", "PNG", optimize=True)

draw_icon(512, maskable=True).save(OUT / "icon-maskable-512.png", "PNG", optimize=True)

print(f"Wrote icons to {OUT}")
