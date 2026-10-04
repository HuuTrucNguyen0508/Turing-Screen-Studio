"""CPU-only rendering of saved layouts, with optional caller-supplied stats."""

from __future__ import annotations

import math
from pathlib import Path
import re

from PIL import Image, ImageDraw, ImageFont

from .layout import _palette, validate_layout

MAX_RENDER_PIXELS = 16_000_000
_SPARK_POINTS = (22, 23, 17, 21, 13, 16, 8, 14, 12, 19, 11, 16, 9, 13, 5, 10)


def _number(stats: object, name: str) -> float | None:
    value = getattr(stats, name, None)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (OverflowError, ValueError):
        return None


def _format(value: float | None, places: int = 0) -> str:
    return "—" if value is None else f"{value:.{places}f}"


def _text(value: object) -> str:
    return str(value) if value is not None and str(value).strip() else "—"


def rendered_content(widget: dict, stats: object = None) -> dict:
    """Return detached display settings without reading sensors or changing input.

    An absent source behaves as sample. Live sources use DashboardStats
    attributes and fixed decimal precision. Missing readings display an em
    dash; unavailable forecast high/low never reuse sample readings.
    """
    settings = dict(widget["settings"])
    source = settings.get("source", "sample")
    if stats is None or source == "sample":
        return settings
    if widget["type"] == "weather":
        if source != "weather":
            return settings
        city = _text(getattr(stats, "weather_city", None))
        country = getattr(stats, "weather_country", None)
        settings.update(
            location=f"{city}, {country}" if city != "—" and country else city,
            temperature=_format(_number(stats, "weather_temp_c")),
            unit="°C",
            condition=_text(getattr(stats, "weather_description", None)),
            high="—", low="—",
        )
    elif source == "cpu":
        settings.update(
            value=_format(_number(stats, "cpu_percent")), unit="%",
            detail=f"{_format(_number(stats, 'cpu_temp'))} °C · "
                   f"{_format(_number(stats, 'cpu_freq_mhz'))} MHz",
        )
    elif source == "gpu":
        used = _number(stats, "gpu_vram_used_mb")
        total = _number(stats, "gpu_vram_total_mb")
        settings.update(
            value=_format(_number(stats, "gpu_percent")), unit="%",
            detail=f"{_format(_number(stats, 'gpu_temp'))} °C · "
                   f"{_format(None if used is None else used / 1024, 1)} / "
                   f"{_format(None if total is None else total / 1024)} GB VRAM",
        )
    elif source == "memory":
        settings.update(
            value=_format(_number(stats, "ram_used_gb"), 1), unit="GB",
            detail=f"{_format(_number(stats, 'ram_total_gb'))} GB installed · "
                   f"{_format(_number(stats, 'ram_percent'))}% used",
        )
    elif source == "disk":
        settings.update(
            value=_format(_number(stats, "disk_percent")), unit="%",
            detail=f"{_format(_number(stats, 'disk_used_gb'), 1)} / "
                   f"{_format(_number(stats, 'disk_total_gb'))} GB",
        )
    elif source in ("network-down", "network-up"):
        speed = _number(stats, "net_down_kbps" if source == "network-down" else "net_up_kbps")
        megabytes = speed is not None and speed >= 1024
        direction = "Download" if source == "network-down" else "Upload"
        interface = getattr(stats, "wifi_iface", None)
        settings.update(
            value=_format(speed / 1024 if megabytes else speed, 1 if megabytes else 0),
            unit="MB/s" if megabytes else "KB/s",
            detail=f"{direction} · {interface}" if interface else direction,
        )
    return settings


class LayoutRenderer:
    """Draw document coordinates directly. The caller owns transport and scaling.

    Fonts come only from font_dir, local DejaVu files, or Pillow's fallback.
    Stats and palette are snapshots supplied by the caller. Rendering never
    imports the original dashboard or reads scheme, sensor, or network data.
    """

    def __init__(self, font_dir: Path | None = None) -> None:
        self.font_dir = Path(font_dir) if font_dir is not None else None
        self._fonts: dict[tuple[str, int], ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}

    def _font(self, family: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        key = family, size
        if key not in self._fonts:
            candidates = []
            if self.font_dir is not None:
                relative = {
                    "mono": "jetbrains-mono/JetBrainsMono-Regular.ttf",
                    "sans": "roboto/Roboto-Regular.ttf",
                }[family]
                candidates.append(self.font_dir / relative)
            candidates.append(Path("/usr/share/fonts/truetype/dejavu") / (
                "DejaVuSansMono.ttf" if family == "mono" else "DejaVuSans.ttf"
            ))
            for candidate in candidates:
                try:
                    self._fonts[key] = ImageFont.truetype(str(candidate), size)
                    break
                except OSError:
                    continue
            else:
                self._fonts[key] = ImageFont.load_default()
        return self._fonts[key]

    @staticmethod
    def _safe_text(text: str) -> str:
        # Bound glyph layout work; the rest of long text is outside the card.
        text = text[:4096]
        return text.encode("utf-8", "replace").decode("utf-8")

    def _draw_text(self, draw: ImageDraw.ImageDraw, xy: tuple[float, float],
                   text: str, color: str, size: int, family: str = "sans",
                   anchor: str = "lt") -> None:
        draw.text(xy, self._safe_text(text), font=self._font(family, size), fill=color, anchor=anchor)

    def _value(self, draw: ImageDraw.ImageDraw, xy: tuple[float, float], value: str,
               unit: str, color: str, unit_color: str, size: int, unit_size: int,
               centered: bool = False, gap: int = 9) -> None:
        value = self._safe_text(value)
        unit = self._safe_text(unit)
        value_width = draw.textlength(value, font=self._font("mono", size))
        unit_width = draw.textlength(unit, font=self._font("sans", unit_size))
        x, y = xy
        if centered:
            x -= (value_width + gap + unit_width) / 2
        self._draw_text(draw, (x, y), value, color, size, "mono")
        self._draw_text(draw, (x + value_width + gap, y + size - unit_size),
                        unit, unit_color, unit_size)

    def _metric(self, draw: ImageDraw.ImageDraw, width: int, height: int,
                settings: dict, palette: dict, stats: object = None) -> None:
        self._draw_text(draw, (29, 27), settings["label"], palette["muted"], 15)
        self._value(draw, (29, 58), settings["value"], settings["unit"],
                    palette["primary"], palette["muted"], 58, 23)
        plot_width = max(1, width - 58)
        plot_height = max(12, min(40, height - 182))
        top = 136
        draw.line((29, top + 26 * plot_height / 32, 29 + plot_width,
                   top + 26 * plot_height / 32), fill=palette["outline"], width=1)
        if stats is None or settings.get('source', 'sample') == 'sample':
            points = [(29 + i * plot_width / 15, top + value * plot_height / 32)
                      for i, value in enumerate(_SPARK_POINTS)]
        else:
            source = settings.get('source')
            attr = {'cpu': 'cpu_history', 'gpu': 'gpu_history', 'memory': 'ram_history'}.get(source)
            history = getattr(stats, attr, []) if attr else []
            history = [float(value) for value in history[-60:] if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)]
            points = [(29 + i * plot_width / max(1, len(history) - 1), top + (1 - min(100, max(0, value)) / 100) * plot_height)
                      for i, value in enumerate(history)]
        if len(points) > 1:
            draw.line(points, fill=palette['primary'], width=2)
        self._draw_text(draw, (29, top + plot_height + 14), settings["detail"], palette["muted"], 14)

    @staticmethod
    def _weather_icon(draw: ImageDraw.ImageDraw, cx: float, top: int, palette: dict) -> None:
        left = cx - 60
        color = palette["secondary"]
        draw.ellipse((left + 59, top + 15, left + 93, top + 49), outline=color, width=3)
        for x1, y1, x2, y2 in (
            (76, 5, 76, 0), (76, 64, 76, 59), (103, 32, 111, 32),
            (42, 32, 49, 32), (96, 12, 102, 6), (50, 58, 56, 52),
            (96, 52, 102, 58), (50, 6, 56, 12),
        ):
            draw.line((left + x1, top + y1, left + x2, top + y2), fill=color, width=3)
        # A closed cloud path, painted over the sun like the browser SVG.
        points = []
        for x, y, radius, start, end in (
            (29, 66, 17, 90, 260), (51, 56, 24, 200, 348),
            (78, 67, 16, 260, 450),
        ):
            points.extend((left + x + radius * math.cos(math.radians(angle)),
                           top + y + radius * math.sin(math.radians(angle)))
                          for angle in range(start, end + 1, 5))
        points.append((left + 29, top + 83))
        draw.polygon(points, fill=palette["surface"])
        draw.line(points + [points[0]], fill=color, width=3)

    def _weather(self, draw: ImageDraw.ImageDraw, width: int, height: int,
                 settings: dict, palette: dict, live: bool) -> None:
        center = width / 2
        self._draw_text(draw, (29, 27), f"Weather / {settings['location']}", palette["muted"], 15)
        self._weather_icon(draw, center, 69, palette)
        self._value(draw, (center, 191), settings["temperature"], settings["unit"],
                    palette["text"], palette["text"], 76, 36, centered=True, gap=3)
        self._draw_text(draw, (center, 296), settings["condition"], palette["muted"], 20, anchor="mt")
        self._draw_text(draw, (center - 14, 352), f"High {settings['high']}°",
                        palette["text"], 15, anchor="rt")
        self._draw_text(draw, (center + 14, 352), f"Low {settings['low']}°",
                        palette["text"], 15)
        self._draw_text(draw, (center, max(403, height - 43)),
                        "Live weather" if live else "Sample forecast", palette["muted"], 13, anchor="mt")

    def _header(self, draw: ImageDraw.ImageDraw, width: int, stats: object, palette: dict) -> None:
        self._draw_text(draw, (64, 47), "TURZX / desktop", palette["muted"], 15)
        self._draw_text(draw, (64, 74), "System overview", palette["text"], 32)
        clock, date = "10:24", "Sunday, 4 October"
        if stats is not None:
            raw = _text(getattr(stats, "clock", None))
            match = re.search(r"\b\d{1,2}:\d{2}\b", raw)
            clock = match.group() if match else raw
            date = raw[:match.start()].strip() if match else ""
        self._draw_text(draw, (width - 64, 47), clock, palette["text"], 37, "mono", "rt")
        self._draw_text(draw, (width - 64, 91), date, palette["muted"], 14, anchor="rt")

    def render(self, document: object, stats: object = None, palette: object = None) -> Image.Image:
        """Return RGB pixels in document dimensions, rejecting huge allocations."""
        doc = validate_layout(document)
        width, height = doc["canvas"]["width"], doc["canvas"]["height"]
        if width * height > MAX_RENDER_PIXELS:
            raise ValueError("$.canvas: rendering is limited to 16 million pixels")
        colors = doc["palette"] if palette is None else _palette(palette, "$.renderPalette")
        image = Image.new("RGB", (width, height), colors["background"])
        draw = ImageDraw.Draw(image)
        self._header(draw, width, stats, colors)
        for widget in doc["widgets"]:
            w, h = widget["width"], widget["height"]
            # The separate layer clips all glyphs and strokes to this card.
            card = Image.new("RGB", (w, h), colors["surface"])
            card_draw = ImageDraw.Draw(card)
            settings = rendered_content(widget, stats)
            if widget["type"] == "metric":
                self._metric(card_draw, w, h, settings, colors, stats)
            else:
                self._weather(card_draw, w, h, settings, colors,
                              stats is not None and settings.get("source", "sample") == "weather")
            radius = min(18, (w - 1) // 2, (h - 1) // 2)
            bounds = (0, 0, w - 1, h - 1)
            mask = Image.new("L", (w, h), 255 if min(w, h) == 1 else 0)
            if min(w, h) == 1:
                card_draw.rectangle(bounds, fill=colors['outline'])
            else:
                card_draw.rounded_rectangle(bounds, radius=radius, outline=colors["outline"], width=1)
                ImageDraw.Draw(mask).rounded_rectangle(bounds, radius=radius, fill=255)
            image.paste(card, (widget["x"], widget["y"]), mask)
        # Match the preview's paint order: footer appears above cards.
        self._draw_text(draw, (64, height - 69),
                        "Deterministic preview" if stats is None else "Live dashboard",
                        colors["muted"], 13, "mono")
        self._draw_text(draw, (width - 64, height - 69), f"{width} / {height}",
                        colors["muted"], 13, "mono", "rt")
        return image
