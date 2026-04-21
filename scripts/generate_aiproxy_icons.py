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


def lerp(start: int, end: int, amount: float) -> int:
    return int(start + (end - start) * amount)


def blend(start: tuple[int, int, int], end: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    return tuple(lerp(a, b, amount) for a, b in zip(start, end))


def rounded_mask(size: int, margin: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((margin, margin, size - margin, size - margin), radius=radius, fill=255)
    return mask


def diagonal_gradient(
    size: int,
    start: tuple[int, int, int],
    end: tuple[int, int, int],
) -> Image.Image:
    image = Image.new("RGBA", (size, size))
    pixels = image.load()

    for y in range(size):
        for x in range(size):
            amount = (x + y) / (size * 2)
            pixels[x, y] = blend(start, end, amount) + (255,)

    return image


def radial_glow(
    size: int,
    center: tuple[float, float],
    radius: float,
    color: tuple[int, int, int],
    alpha: int,
) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    cx = int(center[0] * size)
    cy = int(center[1] * size)
    r = int(radius * size)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color + (alpha,))
    return layer.filter(ImageFilter.GaussianBlur(max(1, r // 2)))


def add_glow(
    base: Image.Image,
    box: tuple[int, int, int, int],
    color: tuple[int, int, int, int],
    blur: int,
) -> Image.Image:
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse(box, fill=color)
    return Image.alpha_composite(base, layer.filter(ImageFilter.GaussianBlur(blur)))


def gradient_fill_from_mask(
    mask: Image.Image,
    start: tuple[int, int, int],
    end: tuple[int, int, int],
    vertical_bias: float = 0.0,
) -> Image.Image:
    width, height = mask.size
    fill = Image.new("RGBA", mask.size)
    pixels = fill.load()

    for y in range(height):
        for x in range(width):
            diagonal = (x + y) / (width + height)
            amount = min(1.0, max(0.0, diagonal * (1.0 - vertical_bias) + (y / height) * vertical_bias))
            pixels[x, y] = blend(start, end, amount) + (255,)

    fill.putalpha(mask)
    return fill


def draw_network_mesh() -> Image.Image:
    mesh = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(mesh)

    draw.arc((320, 260, 1728, 1668), start=212, end=332, fill=(255, 255, 255, 30), width=18)
    draw.arc((430, 395, 1615, 1580), start=206, end=312, fill=(104, 214, 255, 42), width=12)
    draw.ellipse((1478, 534, 1562, 618), fill=(132, 234, 255, 95))

    return mesh.filter(ImageFilter.GaussianBlur(1))


def draw_background() -> Image.Image:
    canvas = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))

    shadow = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))
    shadow_mask = rounded_mask(WORK_SIZE, SAFE_MARGIN, CORNER_RADIUS)
    shadow.putalpha(shadow_mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(110))
    shadow = ImageChops.offset(shadow, 0, 58)
    shadow_layer = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (4, 8, 22, 170))
    shadow_layer.putalpha(shadow.getchannel("A"))
    canvas = Image.alpha_composite(canvas, shadow_layer)

    base = diagonal_gradient(WORK_SIZE, (8, 18, 46), (18, 86, 198))
    base = Image.alpha_composite(base, radial_glow(WORK_SIZE, (0.30, 0.30), 0.18, (94, 220, 255), 72))
    base = Image.alpha_composite(base, radial_glow(WORK_SIZE, (0.70, 0.76), 0.24, (19, 92, 224), 88))
    base.putalpha(rounded_mask(WORK_SIZE, SAFE_MARGIN, CORNER_RADIUS))
    canvas = Image.alpha_composite(canvas, base)

    mesh = draw_network_mesh()
    mesh.putalpha(ImageChops.multiply(mesh.getchannel("A"), rounded_mask(WORK_SIZE, SAFE_MARGIN, CORNER_RADIUS)))
    canvas = Image.alpha_composite(canvas, mesh)

    canvas = add_glow(canvas, (300, 260, 1060, 1040), (109, 244, 255, 28), 130)
    canvas = add_glow(canvas, (1080, 1100, 1880, 1880), (39, 113, 255, 44), 145)

    glass = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glass)
    draw.polygon(
        [
            (180, 340),
            (980, 110),
            (1720, 820),
            (1495, 1050),
            (720, 580),
        ],
        fill=(255, 255, 255, 24),
    )
    draw.rounded_rectangle(
        (SAFE_MARGIN, SAFE_MARGIN, WORK_SIZE - SAFE_MARGIN, WORK_SIZE - SAFE_MARGIN),
        radius=CORNER_RADIUS,
        outline=(255, 255, 255, 36),
        width=16,
    )
    glass.putalpha(ImageChops.multiply(glass.getchannel("A"), rounded_mask(WORK_SIZE, SAFE_MARGIN, CORNER_RADIUS)))
    return Image.alpha_composite(canvas, glass.filter(ImageFilter.GaussianBlur(10)))


def draw_a_mask() -> Image.Image:
    mask = Image.new("L", (WORK_SIZE, WORK_SIZE), 0)
    draw = ImageDraw.Draw(mask)

    top = (WORK_SIZE // 2, 460)
    left = (650, 1465)
    right = (1398, 1465)
    cross_left = (846, 1040)
    cross_right = (1202, 1040)
    line_width = 164
    node_radius = 76

    draw.line([top, left], fill=255, width=line_width)
    draw.line([top, right], fill=255, width=line_width)
    draw.line([cross_left, cross_right], fill=255, width=120)

    for point, radius in [
        (top, 88),
        (left, node_radius),
        (right, node_radius),
        (cross_left, 50),
        (cross_right, 50),
    ]:
        x, y = point
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)

    return mask.filter(ImageFilter.GaussianBlur(2))


def draw_mark() -> Image.Image:
    a_mask = draw_a_mask()

    shadow = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))
    shadow.putalpha(a_mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(62))
    shadow = ImageChops.offset(shadow, 0, 44)
    shadow_tint = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (3, 8, 24, 112))
    shadow_tint.putalpha(shadow.getchannel("A"))

    mark = gradient_fill_from_mask(a_mask, (255, 255, 255), (178, 238, 246), vertical_bias=0.24)

    edge = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))
    edge_draw = ImageDraw.Draw(edge)
    edge_draw.arc((430, 250, 1618, 1512), start=213, end=330, fill=(160, 236, 248, 86), width=18)
    edge_draw.ellipse((1496, 542, 1560, 606), fill=(143, 233, 248, 120))
    edge_draw.line((1024, 608, 1024, 880), fill=(255, 255, 255, 58), width=18)
    edge = edge.filter(ImageFilter.GaussianBlur(1))

    canvas = Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))
    canvas = Image.alpha_composite(canvas, shadow_tint)
    canvas = Image.alpha_composite(canvas, mark)
    canvas = Image.alpha_composite(canvas, edge)
    return canvas


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
