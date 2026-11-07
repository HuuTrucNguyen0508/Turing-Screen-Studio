"""Frost's sheet: one glass slab over the fog, with frameless readings on it.

Glass is a translucent fill over the pre-blurred ground, a 1 px rim along the
inner top edge and a 1 px inset edge, like Frost's dark panels (no shadows).
Secondary text, tracks and hairlines are the ink colour at a fixed alpha, so
they read the same over the fog and over the slab.
"""
from __future__ import annotations

from functools import lru_cache
import math

from PIL import Image, ImageChops, ImageDraw

# Tokens.qml, dark mode: ink2 / track / hairline are ink at these alphas.
INK2, TRACK, HAIRLINE = 0.86, 0.18, 0.14
SLAB_RADIUS = 22
# The reading fill: a vertical gradient (rgb, alpha) top to bottom, then rim, edge and
# a soft specular wash near the top-left. Light mode is the Mist fill.
GLASS = {
    "dark": {"top": ((26, 27, 30), .70), "bottom": ((14, 15, 17), .76), "rim": .34, "edge": .10, "specular": .10},
    "light": {"top": ((255, 255, 255), .32), "bottom": ((255, 255, 255), .20), "rim": .92, "edge": .34, "specular": .10},
}
# Fira Sans line box: ascender .935 em and descender .265 em, as a browser lays it out.
_ASCENT, _CONTENT = .935, 1.2


def baseline(top: float, box: float, size: int) -> int:
    """The baseline of one line of `size` px text centred in a `box` px line box.

    Browsers round the ascent and descent to pixels and floor the half-leading."""
    ascent, descent = round(_ASCENT * size), round((_CONTENT - _ASCENT) * size)
    return math.floor(top + (box - ascent - descent) / 2) + ascent


def _rounded_mask(size: tuple[int, int], radius: int, inset: int = 0, dy: int = 0) -> Image.Image:
    """An antialiased rounded rectangle, drawn at 4x and reduced."""
    scale = 4
    width, height = size
    big = Image.new("L", (width * scale, height * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (inset * scale, (inset + dy) * scale, (width - inset) * scale - 1, (height - inset + dy) * scale - 1),
        radius=max(0, radius - inset) * scale, fill=255)
    return big.resize(size, Image.BOX)


def _scaled(mask: Image.Image, alpha: float) -> Image.Image:
    return mask.point([round(value * alpha) for value in range(256)])


@lru_cache(maxsize=8)
def glass_layer(width: int, height: int, mode: str) -> Image.Image:
    """The slab's RGBA material for one size, composited over whatever lies beneath."""
    tokens = GLASS[mode]
    (top_rgb, top_a), (bottom_rgb, bottom_a) = tokens["top"], tokens["bottom"]
    column = Image.new("RGBA", (1, height))
    for y in range(height):
        t = y / max(1, height - 1)
        alpha = top_a + (bottom_a - top_a) * t
        # Browsers interpolate gradients in premultiplied alpha.
        rgb = tuple(round((a * top_a * (1 - t) + b * bottom_a * t) / alpha) for a, b in zip(top_rgb, bottom_rgb))
        column.putpixel((0, y), (*rgb, round(alpha * 255)))
    layer = column.resize((width, height), Image.NEAREST)
    # radial-gradient(70% 55% at 18% 0%, white a -> 0 at 70%), computed at quarter size.
    small = (max(1, width // 4), max(1, height // 4))
    wash = Image.new("L", small, 0)
    cx, rx, ry = .18 * small[0], .70 * small[0], .55 * small[1]
    wash.putdata([round(255 * tokens["specular"] * max(0.0, 1 - math.hypot((x + .5 - cx) / rx, (y + .5) / ry) / .70))
                  for y in range(small[1]) for x in range(small[0])])
    white = Image.new("RGBA", (width, height), (255, 255, 255, 0))
    white.putalpha(wash.resize((width, height), Image.BILINEAR))
    layer.alpha_composite(white)
    outer = _rounded_mask((width, height), SLAB_RADIUS)
    edge = ImageChops.subtract(outer, _rounded_mask((width, height), SLAB_RADIUS, inset=1))
    rim = ImageChops.subtract(outer, _rounded_mask((width, height), SLAB_RADIUS, dy=1))
    for mask, alpha in ((edge, tokens["edge"]), (rim, tokens["rim"])):
        line = Image.new("RGBA", (width, height), (255, 255, 255, 0))
        line.putalpha(_scaled(mask, alpha))
        layer.alpha_composite(line)
    layer.putalpha(ImageChops.multiply(layer.getchannel("A"), outer))
    return layer


class Ink:
    """Draw in the ink colour at full strength or at one of Frost's alphas.

    Full ink draws straight onto the card. Translucent marks collect in one mask
    per alpha and are laid over the card by flush(); ink over ink stays ink, so
    the order of marks of the same colour does not matter.
    """

    def __init__(self, card: Image.Image, color: str) -> None:
        self.card, self.color = card, color
        self.direct = ImageDraw.Draw(card)
        self.masks: dict[float, tuple[Image.Image, ImageDraw.ImageDraw]] = {}

    def target(self, alpha: float) -> tuple[ImageDraw.ImageDraw, str | int]:
        if alpha >= 1:
            return self.direct, self.color
        if alpha not in self.masks:
            mask = Image.new("L", self.card.size, 0)
            self.masks[alpha] = mask, ImageDraw.Draw(mask)
        return self.masks[alpha][1], 255

    def bar(self, box: tuple[float, float, float, float], alpha: float = 1.0) -> None:
        x0, y0, x1, y1 = box
        if x1 <= x0:
            return
        draw, fill = self.target(alpha)
        draw.rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=min(1, (y1 - y0) // 2), fill=fill)

    def flush(self) -> None:
        for alpha, (mask, _) in self.masks.items():
            self.card.paste(self.color, (0, 0), _scaled(mask, alpha))
        self.masks.clear()


def facts_from(stats: object, source: str) -> tuple[str | None, list[tuple[str, str]]]:
    """A figure column's device name and its "value word" fact lines."""
    def number(name):
        value = getattr(stats, name, None)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return None
        return float(value)

    def fixed(value, places):
        return "—" if value is None else f"{value:.{places}f}"

    def of(used, total, places=1):
        return f"{fixed(used, places)} of {fixed(total, places)} GiB"

    if source in ("cpu", "cpu-temperature"):
        freq = number("cpu_freq_mhz")
        name = getattr(stats, "cpu_name", None)
        return (name if isinstance(name, str) and name.strip() else None,
                [(f"{fixed(number('cpu_temp'), 0)} °C", "temperature"),
                 (f"{fixed(None if freq is None else freq / 1000, 2)} GHz", "clock")])
    if source in ("gpu", "gpu-temperature"):
        used, total = number("gpu_vram_used_mb"), number("gpu_vram_total_mb")
        name = getattr(stats, "gpu_name", None)
        return (name if isinstance(name, str) and name.strip() else None,
                [(f"{fixed(number('gpu_temp'), 0)} °C", "temperature"),
                 (of(None if used is None else used / 1024, None if total is None else total / 1024), "memory")])
    if source == "memory":
        return None, [(of(number("ram_used_gb"), number("ram_total_gb")), "used")]
    if source == "disk":
        return None, [(of(number("disk_used_gb"), number("disk_total_gb")), "used")]
    return None, []
