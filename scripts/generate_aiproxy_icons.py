from pathlib import Path
import shutil

from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "apps" / "desktop" / "src-tauri" / "icons"
MASTER_PATH = ICON_DIR / "aiproxy-logo-master.png"
WORK_SIZE = 2048
MASTER_SIZE = 1024
SAFE_MARGIN = 96
CORNER_RADIUS = 460


def make_diagonal_gradient(size: int, start: tuple[int, int, int], end: tuple[int, int, int]) -> Image.Image:
    base = Image.new("RGBA", (size, size), start + (255,))
    overlay = Image.new("RGBA", (size, size), end + (255,))
    mask = Image.linear_gradient("L").resize((size * 2, size * 2)).rotate(45, expand=False)
    mask = mask.crop((size // 2, size // 2, size // 2 + size, size // 2 + size))
    return Image.composite(overlay, base, mask)


def rounded_mask(size: int, margin: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((margin, margin, size - margin, size - margin), radius=radius, fill=255)
    return mask


def add_glow(base: Image.Image, box: tuple[int, int, int, int], color: tuple[int, int, int, int], blur: int) -> Image.Image:
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse(box, fill=color)
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(base, layer)


def draw_background() -> Image.Image:
    canvas = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))

    shadow = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))
    shadow_mask = rounded_mask(WORK_SIZE, SAFE_MARGIN, CORNER_RADIUS)
    shadow.putalpha(shadow_mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(110))
    shadow = ImageChops.offset(shadow, 0, 56)
    canvas = Image.alpha_composite(canvas, shadow)

    tile = make_diagonal_gradient(WORK_SIZE, (6, 19, 56), (26, 214, 255))
    tile.putalpha(rounded_mask(WORK_SIZE, SAFE_MARGIN, CORNER_RADIUS))
    canvas = Image.alpha_composite(canvas, tile)

    canvas = add_glow(canvas, (250, 220, 1300, 1240), (101, 233, 255, 135), 120)
    canvas = add_glow(canvas, (980, 1040, 1930, 1990), (22, 96, 255, 115), 150)

    glass = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glass)
    draw.polygon(
        [
            (220, 320),
            (940, 140),
            (1680, 840),
            (1420, 1080),
            (650, 600),
        ],
        fill=(255, 255, 255, 42),
    )
    draw.rounded_rectangle(
        (SAFE_MARGIN, SAFE_MARGIN, WORK_SIZE - SAFE_MARGIN, WORK_SIZE - SAFE_MARGIN),
        radius=CORNER_RADIUS,
        outline=(255, 255, 255, 52),
        width=18,
    )
    glass.putalpha(ImageChops.multiply(glass.getchannel("A"), rounded_mask(WORK_SIZE, SAFE_MARGIN, CORNER_RADIUS)))
    glass = glass.filter(ImageFilter.GaussianBlur(10))
    return Image.alpha_composite(canvas, glass)


def scale(points: list[tuple[float, float]]) -> list[tuple[int, int]]:
    return [(int(x * WORK_SIZE), int(y * WORK_SIZE)) for x, y in points]


def draw_mark() -> Image.Image:
    mark_mask = Image.new("L", (WORK_SIZE, WORK_SIZE), 0)
    draw = ImageDraw.Draw(mark_mask)

    left_leg = scale([(0.31, 0.78), (0.39, 0.24), (0.47, 0.24), (0.39, 0.78)])
    right_leg = scale([(0.53, 0.24), (0.61, 0.24), (0.69, 0.78), (0.61, 0.78)])
    crossbar = (
        int(0.40 * WORK_SIZE),
        int(0.50 * WORK_SIZE),
        int(0.61 * WORK_SIZE),
        int(0.58 * WORK_SIZE),
    )

    draw.polygon(left_leg, fill=255)
    draw.polygon(right_leg, fill=255)
    draw.rounded_rectangle(crossbar, radius=40, fill=255)

    carve = ImageDraw.Draw(mark_mask)
    carve.polygon(scale([(0.50, 0.36), (0.56, 0.60), (0.44, 0.60)]), fill=0)
    carve.polygon(scale([(0.47, 0.61), (0.54, 0.61), (0.58, 0.79), (0.43, 0.79)]), fill=0)

    shadow = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))
    shadow.putalpha(mark_mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(55))
    shadow = ImageChops.offset(shadow, 0, 46)

    canvas = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))
    shadow_color = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (3, 9, 30, 145))
    shadow_color.putalpha(shadow.getchannel("A"))
    canvas = Image.alpha_composite(canvas, shadow_color)

    white_mark = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (255, 255, 255, 0))
    white_mark.putalpha(mark_mask)
    canvas = Image.alpha_composite(canvas, white_mark)

    accent = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))
    accent_draw = ImageDraw.Draw(accent)
    accent_draw.rounded_rectangle(crossbar, radius=40, fill=(32, 229, 255, 255))
    accent_draw.ellipse(
        (
            int(0.60 * WORK_SIZE),
            int(0.47 * WORK_SIZE),
            int(0.68 * WORK_SIZE),
            int(0.55 * WORK_SIZE),
        ),
        fill=(32, 229, 255, 255),
    )
    accent = accent.filter(ImageFilter.GaussianBlur(2))
    return Image.alpha_composite(canvas, accent)


def save_resized(image: Image.Image, path: Path, size: int) -> None:
    image.resize((size, size), Image.Resampling.LANCZOS).save(path)


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(ICON_DIR / "icon.iconset", ignore_errors=True)

    background = draw_background()
    mark = draw_mark()
    composed = Image.alpha_composite(background, mark)
    master = composed.resize((MASTER_SIZE, MASTER_SIZE), Image.Resampling.LANCZOS)

    master.save(MASTER_PATH)
    master.save(ICON_DIR / "128x128@2x.png")
    save_resized(master, ICON_DIR / "icon.png", 512)
    save_resized(master, ICON_DIR / "128x128.png", 128)
    save_resized(master, ICON_DIR / "64x64.png", 64)
    save_resized(master, ICON_DIR / "32x32.png", 32)

    master.save(
        ICON_DIR / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    master.save(ICON_DIR / "icon.icns")


if __name__ == "__main__":
    main()
