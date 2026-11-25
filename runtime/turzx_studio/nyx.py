"""The shell's Nyx style for the panel: its palette, sky, grid, slabs, meters and cut type.

Nyx is a night sky seen through a screen door. The shell picks it by wallpaper, as it picks
Frost: Nyx is active while its style.json lists the current wallpaper. Nyx is dark only. In
light mode the Nyx style pairs with Frost Light, so the palette here is Frost's light one.

The panel draws Nyx's grid itself. Its cell is 8 px with a 2 px black line on the left and
bottom edge: the panel is about 190 ppi, so this cell looks the size of the desktop's 5 px one,
and 8 px is the JPEG block. 1280 and 800 are multiples of 8, so the rotated wire frame keeps
every cell inside one block.
"""
from __future__ import annotations

from functools import lru_cache
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

from .frost import PALETTES as FROST_PALETTES
from .sheet import INK2, Ink as _SheetInk

NYX = "nyx"

# The eight layout roles. `primary` and `secondary` are the two ends of a lit meter.
PALETTE = {"name": NYX, "background": "#000000", "surface": "#03030a",
           "surfaceRaised": "#0d0c20", "text": "#f1f0ff", "muted": "#a6a3c0",
           "primary": "#8a7fe8", "secondary": "#6f8cff", "outline": "#1f1f27"}

HIGHLIGHT = "#b4aaff"                      # weather glyph, the "Working" mark
ROSE = "#e0648f"                           # the end of a meter past WARN_FROM
CUT_GRADIENT = ("#d2c8ff", "#9aa6ff")      # the grid-cut clock, at CUT_ANGLE
CUT_ANGLE = 170                            # CSS degrees: 180 points down
MARK_GRADIENT = ("#d2c8ff", "#6f8cff")     # the lit cell before "Working", at 135 degrees
SLAB = ((3, 3, 10), .92)                   # readings sit on the surface at 92%
SLAB_EDGE, SLAB_RIM = .07, .04             # 1 px white border, and a 1 px top highlight inside it
HAIRLINE = .07                             # white at this alpha: rules between sheet sections
TRACK = .12                                # the unlit cells of a meter: HIGHLIGHT at this alpha
WARN_FROM = .90                            # a meter past this share ends in rose

CELL, LINE = 8, 2
METER_ROWS = 2
RADIUS = {"slab": 4 * CELL, "chip": 2 * CELL}

# The sky: the shell's wallpaper is art at one pixel per 5 px desktop cell, behind a 1 px grid.
# The panel samples one pixel per desktop cell and shows a window of that art at one art pixel
# per panel cell, unblurred. The window's top-left corner, as a share of the art, keeps dark
# starfield behind the clock and the bright nebula along the bottom and right.
ART_CELL = 5
SKY_ORIGIN = (.1715, .0833)
SKY_RECIPE = 1

# Rubik's variable face; Arch's package keeps the URL-escaped name of the upstream file.
FONTS = (Path("/usr/share/fonts/TTF/Rubik[wght].ttf"), Path("/usr/share/fonts/TTF/Rubik%5Bwght%5D.ttf"))
WEIGHTS = {"display": 800, "figure": 500, "mono": 500, "medium": 500, "sans": 400}
# The sheet's Fira sizes, read in Rubik: labels 15 -> 17, secondary lines 14 -> 15,
# a storage share 28 -> 26; figures scale by FIGURE_SCALE (the 72 px sheet figure -> 56).
SIZES = {14: 15, 15: 17, 28: 26}
FIGURE_SCALE = 56 / 72
TRACKING = {"display": -.015, "figure": -.02}
ICON_AXES = (1, 0, 48, 400)                # Material Symbols, filled, as the shell's weather


def nyx_palette(light: bool = False) -> dict:
    """Nyx in dark mode, Frost Light in light mode."""
    return dict(FROST_PALETTES["light"] if light else PALETTE)


def weather_glyph(icon: object, condition: str, frost_glyph) -> str:
    """Frost's glyphs, with the moon at night: the shell's sky is a night sky."""
    if isinstance(icon, str) and icon.endswith("n"):
        night = {"01": "bedtime", "02": "partly_cloudy_night"}.get(icon[:2])
        if night:
            return night
    return frost_glyph(icon, condition)


def snap(value: float) -> int:
    """The nearest lattice line."""
    return CELL * round(value / CELL)


def on_line(x: int, y: int) -> bool:
    """Whether a panel pixel is part of the grid: the left 2 px or the bottom 2 px of its cell."""
    return x % CELL < LINE or y % CELL >= CELL - LINE


@lru_cache(maxsize=32)
def grid_mask(width: int, height: int, left: int = 0, top: int = 0) -> Image.Image:
    """255 on grid lines for a box whose top-left pixel sits at panel (left, top)."""
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    for x in range(-(left % CELL), width, CELL):
        draw.rectangle((x, 0, x + LINE - 1, height - 1), fill=255)
    for y in range(CELL - LINE - (top % CELL), height, CELL):
        draw.rectangle((0, y, width - 1, y + LINE - 1), fill=255)
    return mask


def make_sky(source: Path, size: tuple[int, int]) -> Image.Image:
    """The wallpaper's art at one pixel per panel cell, scaled up unblurred, behind the grid."""
    width, height = size
    columns, rows = math.ceil(width / CELL), math.ceil(height / CELL)
    with Image.open(source) as raw:
        image = raw.convert("RGB")
    # One sample per desktop cell, from its middle pixel (the cell's grid line is its left
    # column and bottom row), so the art comes back without the shell's lines.
    art_w, art_h = max(1, image.width // ART_CELL), max(1, image.height // ART_CELL)
    art = image.resize((art_w, art_h), Image.NEAREST, box=(0, 0, art_w * ART_CELL, art_h * ART_CELL))
    if art_w < columns or art_h < rows:
        scale = max(columns / art_w, rows / art_h)
        art = art.resize((math.ceil(art_w * scale), math.ceil(art_h * scale)), Image.NEAREST)
    left = min(round(art.width * SKY_ORIGIN[0]), art.width - columns)
    top = min(round(art.height * SKY_ORIGIN[1]), art.height - rows)
    window = art.crop((left, top, left + columns, top + rows))
    sky = window.resize((columns * CELL, rows * CELL), Image.NEAREST).crop((0, 0, width, height))
    sky.paste((0, 0, 0), (0, 0), grid_mask(width, height))
    return sky


def _rgb(color: str) -> tuple[int, int, int]:
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def mix(a: str, b: str, t: float) -> tuple[int, int, int]:
    return tuple(round(x + (y - x) * t) for x, y in zip(_rgb(a), _rgb(b)))


def _rounded(size: tuple[int, int], radius: int, inset: int = 0, dy: int = 0) -> Image.Image:
    scale = 4
    width, height = size
    big = Image.new("L", (width * scale, height * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (inset * scale, (inset + dy) * scale, (width - inset) * scale - 1, (height - inset + dy) * scale - 1),
        radius=max(0, radius - inset) * scale, fill=255)
    return big.resize(size, Image.BOX)


@lru_cache(maxsize=8)
def slab_layer(width: int, height: int, radius: int) -> Image.Image:
    """The reading slab: surface at 92%, a 1 px white border at 7% and a top highlight at 4%."""
    rgb, alpha = SLAB
    outer = _rounded((width, height), radius)
    inner = _rounded((width, height), radius, inset=1)
    layer = Image.new("RGBA", (width, height), (*rgb, 0))
    layer.putalpha(outer.point([round(value * alpha) for value in range(256)]))
    for mask, strength in ((ImageChops.subtract(outer, inner), SLAB_EDGE),
                           (ImageChops.subtract(inner, _rounded((width, height), radius, inset=1, dy=1)), SLAB_RIM)):
        line = Image.new("RGBA", (width, height), (255, 255, 255, 0))
        line.putalpha(mask.point([round(value * strength) for value in range(256)]))
        layer.alpha_composite(line)
    return layer


def paste_slab(card: Image.Image, box: tuple[int, int, int, int], radius: int) -> None:
    """Lay a slab over part of an RGB card, in card coordinates."""
    x0, y0, x1, y1 = box
    region = card.crop(box).convert("RGBA")
    region.alpha_composite(slab_layer(x1 - x0, y1 - y0, radius))
    card.paste(region.convert("RGB"), (x0, y0))


@lru_cache(maxsize=8)
def gradient(width: int, height: int, start: str, end: str, angle: float) -> Image.Image:
    """A CSS linear-gradient(angle, start, end) filling a width x height box."""
    radians = math.radians(angle)
    dx, dy = math.sin(radians), -math.cos(radians)
    length = abs(width * dx) + abs(height * dy) or 1
    ramp = Image.new("L", (width, height))
    ramp.putdata([max(0, min(255, round(255 * (((x + .5 - width / 2) * dx + (y + .5 - height / 2) * dy) / length + .5))))
                  for y in range(height) for x in range(width)])
    return Image.composite(Image.new("RGB", (width, height), end), Image.new("RGB", (width, height), start), ramp)


def cut_text(card: Image.Image, mask: Image.Image, origin: tuple[int, int]) -> None:
    """Add grid-cut type to the sky: `mask` is the type's coverage in card coordinates.

    The grid takes its lines out of the type, the gradient fills it, and the result is added to
    the pixels beneath (plus-lighter), so the sky's own light shows through the letters."""
    box = mask.getbbox()
    if box is None:
        return
    x0, y0, x1, y1 = box
    coverage = ImageChops.subtract(mask.crop(box), grid_mask(x1 - x0, y1 - y0, origin[0] + x0, origin[1] + y0))
    light = ImageChops.multiply(gradient(x1 - x0, y1 - y0, *CUT_GRADIENT, CUT_ANGLE), coverage.convert("RGB"))
    card.paste(ImageChops.add(card.crop(box), light), box[:2])


def meter_cells(left: float, right: float) -> range:
    """The panel columns of a meter spanning [left, right): every cell whose lit part is mostly inside."""
    first = math.ceil((left - LINE - (CELL - LINE) / 2) / CELL)
    last = math.floor((right - CELL + (CELL - LINE) / 2) / CELL)
    return range(first, max(first, last + 1))


def paint_meter(card: Image.Image, origin: tuple[int, int], left: float, right: float, top: float,
                fraction: float | None) -> None:
    """A meter as lit cells, METER_ROWS cells tall, on the panel lattice.

    `left`, `right` and `top` are card coordinates of the column the meter belongs to; `origin`
    is the card's panel position. Lit cells run violet to periwinkle, or violet to rose past
    WARN_FROM; the others are the highlight at 12% over what lies beneath."""
    ox, oy = origin
    columns = meter_cells(ox + left, ox + right)
    first_row = round((oy + top) / CELL)
    count = len(columns)
    lit = 0 if fraction is None else round(count * max(0.0, min(1.0, fraction)))
    end = ROSE if fraction is not None and fraction > WARN_FROM else PALETTE["secondary"]
    lit_size = CELL - LINE
    track = Image.new("L", (lit_size, lit_size), round(255 * TRACK))
    for index, column in enumerate(columns):
        color = (mix(PALETTE["primary"], end, (index + .5) / lit) if index < lit else None)
        for row in range(first_row, first_row + METER_ROWS):
            x, y = column * CELL + LINE - ox, row * CELL - oy
            if color is not None:
                card.paste(color, (x, y, x + lit_size, y + lit_size))
            else:
                card.paste(HIGHLIGHT, (x, y, x + lit_size, y + lit_size), track)


class Ink(_SheetInk):
    """Frost's sheet ink, with its secondary alpha read as Nyx's muted colour."""

    def __init__(self, card: Image.Image, color: str, muted: str) -> None:
        super().__init__(card, color)
        self.muted = muted

    def flush(self) -> None:
        for alpha, (mask, _) in self.masks.items():
            if alpha == INK2:
                self.card.paste(self.muted, (0, 0), mask)
            else:
                self.card.paste(self.color, (0, 0), mask.point([round(value * alpha) for value in range(256)]))
        self.masks.clear()
