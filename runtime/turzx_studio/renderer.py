"""CPU-only rendering of saved layouts, with optional caller-supplied stats."""

from __future__ import annotations

import math
from pathlib import Path
import re

from PIL import Image, ImageDraw, ImageFont

from .layout import _palette, validate_layout
from .design import clock_time, resolve_elements
from .usage_display import USAGE_SOURCES, usage_content
from .storage_display import storage_content, storage_geometry, storage_size, storage_short, storage_row_name
from .trend import widget_trend, trend_unit

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


def gauge_fraction(value: float, minimum: float, maximum: float) -> float:
    if value <= minimum:
        return 0
    if value >= maximum:
        return 1
    if math.isfinite(maximum - minimum):
        return (value - minimum) / (maximum - minimum)
    # Divide first to keep finite extreme bounds from overflowing subtraction.
    scale = max(abs(minimum), abs(maximum), 1)
    return min(1, max(0, (value / scale - minimum / scale) /
                         (maximum / scale - minimum / scale)))


def gauge_geometry(width: int, height: int) -> dict:
    radius = math.floor(min((width - 68) / 2, (height - 150) / 1.5))
    return {"radius": radius, "cx": width / 2, "cy": 63 + radius,
            "size": max(24, min(58, math.floor(radius * .48)))}


def gauge_number(value: float) -> str:
    if abs(value) > 1e14:
        return str(value)
    rounded = math.floor(value * 10 + .5) / 10
    return str(int(rounded)) if rounded.is_integer() else str(rounded)


def instrument_geometry(width: int, height: int) -> dict:
    padding = min(29, width // 6)
    available = max(1, width - 2 * padding)
    radius = math.floor(min((available - 10) / 2, (height - 128) / 2))
    return {"padding": padding, "available": available, "radius": radius,
            "cx": width / 2, "cy": 63 + radius,
            "meter_y": math.floor(63 + max(0, height - 127) * .58),
            "size": max(12, min(58, available // 4)),
            "show_shape": width >= 120 and height >= 160}


def rendered_content(widget: dict, stats: object = None) -> dict:
    """Return detached display settings without reading sensors or changing input.

    An absent source behaves as sample. Live sources use DashboardStats
    attributes and fixed decimal precision. Missing readings display an em
    dash; unavailable forecast high/low never reuse sample readings.
    """
    settings = dict(widget["settings"])
    source = settings.get("source", "sample")
    if widget["type"] == "storage":
        return storage_content(widget, getattr(stats, "ai_usage", None), preview=stats is None)
    if stats is None or source == "sample":
        return settings
    if source in USAGE_SOURCES:
        return usage_content(widget, getattr(stats, 'ai_usage', None))
    if widget["type"] == "clock":
        raw = _text(getattr(stats, "clock", None))
        match = re.search(r"\b\d{1,2}:\d{2}\b", raw)
        settings.update(time=clock_time(match.group() if match else "—", settings["format"]),
                        date=raw[:match.start()].strip() if match else "—")
        return settings
    if widget["type"] == "gauge":
        attr = {"cpu": "cpu_percent", "gpu": "gpu_percent", "memory": "ram_percent",
                "disk": "disk_percent", "network-down": "net_down_kbps", "network-up": "net_up_kbps",
                "cpu-temperature": "cpu_temp", "gpu-temperature": "gpu_temp"}.get(source)
        number = _number(stats, attr) if attr else None
        units = {"cpu": "%", "gpu": "%", "memory": "%", "disk": "%",
                 "network-down": "KB/s", "network-up": "KB/s",
                 "cpu-temperature": "°C", "gpu-temperature": "°C"}
        metric_settings = rendered_content({**widget, "type": "metric", "settings": {
            "label": settings["label"], "value": str(settings["value"]), "unit": settings["unit"],
            "detail": settings["detail"], "source": source,
        }}, stats)
        detail = metric_settings["detail"]
        if source == "memory":
            detail = f"{_format(_number(stats, 'ram_used_gb'), 1)} / {_format(_number(stats, 'ram_total_gb'))} GB"
        settings.update(value=number, unit=units.get(source, settings["unit"]), detail=detail)
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
    elif source in ("cpu-temperature", "gpu-temperature"):
        name = getattr(stats, "cpu_name" if source == "cpu-temperature" else "gpu_name", None)
        settings.update(value=_format(_number(stats, "cpu_temp" if source == "cpu-temperature" else "gpu_temp")),
                        unit="°C", detail=name if isinstance(name, str) and name.strip() else "CPU" if source == "cpu-temperature" else "GPU")
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
        self._wrapped: dict[tuple[str, int], list[str]] = {}

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
        if settings.get('trend'):
            self._trend_metric(draw, width, height, settings, palette, stats)
            return
        if settings.get('source') in USAGE_SOURCES:
            self._usage_metric(draw, width, height, settings, palette)
            return
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

    def _trend_metric(self, draw: ImageDraw.ImageDraw, width: int, height: int,
                      settings: dict, palette: dict, stats: object = None) -> None:
        chart, caption = widget_trend(settings, stats, width, height)
        source = settings.get('source', 'sample')
        size = max(12, min(36, math.floor((width - 58) / max(1, len(settings['value']) * .64 + len(settings['unit']) * .3))))

        def shortened(text, character_width):
            capacity = max(1, math.floor((width - 58) / character_width))
            return text[:capacity - 1] + '…' if len(text) > capacity else text

        self._draw_text(draw, (29, 42), shortened(settings['label'], 8), palette['muted'], 15, anchor='ls')
        self._draw_text(draw, (29, 92), settings['value'], palette['primary'], size, 'mono', 'ls')
        value_width = draw.textlength(self._safe_text(settings['value']), font=self._font('mono', size))
        self._draw_text(draw, (35 + value_width, 92), settings['unit'], palette['muted'], 16, anchor='ls')
        if chart['showChart']:
            bounds = f"{gauge_number(chart['min'])}-{gauge_number(chart['max'])} {trend_unit(source)}".strip()
            self._draw_text(draw, (chart['right'], chart['top'] - 10), bounds, palette['muted'], 11, anchor='rs')
            draw.line((chart['left'], chart['bottom'], chart['right'], chart['bottom']), fill=palette['outline'])
            for points in chart['segments']:
                coordinates = [(point['x'], point['y']) for point in points]
                if len(coordinates) > 1:
                    draw.line(coordinates, fill=palette['primary'], width=2)
                else:
                    x, y = coordinates[0]
                    draw.ellipse((x - 1, y - 1, x + 1, y + 1), fill=palette['primary'])
            if chart['state']:
                self._draw_text(draw, (chart['left'], (chart['top'] + chart['bottom']) // 2),
                                chart['state'], palette['muted'], 13, anchor='ls')
        if height >= 216:
            self._draw_text(draw, (29, height - 48), shortened(settings['detail'], 6.7), palette['muted'], 12, anchor='ls')
        self._draw_text(draw, (29, chart['captionY']), shortened(caption, 6.7), palette['muted'], 12, anchor='ls')

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

    def _usage_metric(self, draw, width, height, settings, palette):
        model_lines = self._safe_text(settings['detail']).split('\n')
        rows = [line.split('\t') for line in model_lines[1:] if len(line.split('\t')) == 3]
        if settings['source'].endswith('-models') and rows:
            chars = max(1, math.floor((width - 158) / 6.6))
            capacity = max(0, math.floor((height - 78) / 18))
            shown = rows[:capacity]
            self._draw_text(draw, (29, 25), settings['label'], palette['muted'], 15, anchor='ls')
            self._draw_text(draw, (width - 29, 25), settings['value'], palette['primary'], 11, 'mono', 'rs')
            for x, text, anchor in [(29, 'Model', 'ls'), (width - 80, 'Tokens', 'rs'), (width - 29, 'USD*', 'rs')]:
                self._draw_text(draw, (x, 43), text, palette['muted'], 10, anchor=anchor)
            for index, (name, tokens, cost) in enumerate(shown):
                name = name if len(name) <= chars else name[:max(0, chars - 1)] + '…'
                y = 60 + index * 18
                self._draw_text(draw, (29, y), name, palette['text'], 11, 'mono', 'ls')
                self._draw_text(draw, (width - 80, y), tokens, palette['primary'], 11, 'mono', 'rs')
                self._draw_text(draw, (width - 29, y), cost, palette['primary'], 11, 'mono', 'rs')
            note = (f'+{len(rows) - len(shown)} more · ' if len(shown) < len(rows) else '') + model_lines[0]
            self._draw_text(draw, (29, height - 23), note[:math.floor((width - 58) / 6.1)], palette['muted'], 10, anchor='ls')
            return
        compact = height < 184
        size = max(12, min(36 if compact else 52, math.floor(max(1, width - 58) / max(1, len(settings['value']) * .64))))
        baseline = 76 if compact else 58 + size
        self._draw_text(draw, (29, 25 if compact else 42), settings['label'], palette['muted'], 15, anchor='ls')
        self._draw_text(draw, (29, baseline), settings['value'], palette['primary'], size, 'mono', 'ls')
        if settings['unit']:
            self._draw_text(draw, (38 + len(settings['value']) * size * .64 if compact else 29,
                                  baseline if compact else baseline + 27), settings['unit'], palette['muted'], 17, anchor='ls')
        chars = max(1, math.floor((width - 58) / 7.7))
        lines = re.findall(rf'.{{1,{chars}}}(?:\s|$)|.{{1,{chars}}}', self._safe_text(settings['detail']))[:1 if compact else 2]
        for index, line in enumerate(lines):
            self._draw_text(draw, (29, height - (len(lines) - index - 1) * 19 - 23), line.strip(), palette['muted'], 14, anchor='ls')

    def _header(self, draw: ImageDraw.ImageDraw, width: int, stats: object, palette: dict,
                show_clock: bool = True, heading: str = 'System overview') -> None:
        self._draw_text(draw, (64, 47), "TURZX / desktop", palette["muted"], 15)
        self._draw_text(draw, (64, 74), heading, palette["text"], 32)
        if not show_clock:
            return
        clock, date = "10:24", "Sunday, 4 October"
        if stats is not None:
            raw = _text(getattr(stats, "clock", None))
            match = re.search(r"\b\d{1,2}:\d{2}\b", raw)
            clock = match.group() if match else raw
            date = raw[:match.start()].strip() if match else ""
        self._draw_text(draw, (width - 64, 47), clock, palette["text"], 37, "mono", "rt")
        self._draw_text(draw, (width - 64, 91), date, palette["muted"], 14, anchor="rt")

    def _designed_text(self, draw: ImageDraw.ImageDraw, elements: list[dict], palette: dict) -> None:
        for element in elements:
            if element["hidden"]:
                continue
            text = self._safe_text(element["text"])
            x, y = element["x"], element["y"]
            color = palette[element["color"]]
            size, family = element["size"], element["family"]
            suffix = self._safe_text(element.get("suffix", ""))
            if suffix:
                digits_width = draw.textlength(text, font=self._font(family, size))
                suffix_size, gap = element["suffixSize"], element["gap"]
                width = digits_width + gap + draw.textlength(suffix, font=self._font("sans", suffix_size))
                left = x - (width / 2 if element["align"] == "center" else width if element["align"] == "end" else 0)
                self._draw_text(draw, (left, y), text, color, size, family, "ls")
                self._draw_text(draw, (left + digits_width + gap, y), suffix, palette["muted"], suffix_size, "sans", "ls")
            else:
                anchor = {"start": "ls", "center": "ms", "end": "rs"}[element["align"]]
                self._draw_text(draw, (x, y), text, color, size, family, anchor)

    def _clock(self, draw: ImageDraw.ImageDraw, height: int, settings: dict, palette: dict) -> None:
        compact = height < 184
        if not compact and settings["label"]:
            self._draw_text(draw, (29, 27), settings["label"], palette["muted"], 15)
        size, unit_size = (40, 16) if compact else (72, 23)
        baseline = height // 2 + (4 if settings["showDate"] else 15) if compact else 124
        parts = clock_time(settings["time"], settings["format"]).split(" ", 1)
        digits, suffix = parts[0], parts[1] if len(parts) > 1 else ""
        self._value(draw, (29, baseline - size + 5), digits, suffix,
                    palette["text"] if compact else palette["primary"], palette["muted"],
                    size, unit_size, gap=6 if compact else 9)
        if settings["showDate"]:
            self._draw_text(draw, (29, height // 2 + 26 if compact else height - 29),
                            settings["date"], palette["muted"], 14 if compact else 15, anchor="ls")

    def _text_card(self, draw: ImageDraw.ImageDraw, width: int, height: int,
                   settings: dict, palette: dict) -> None:
        if settings["label"]:
            self._draw_text(draw, (29, 27), settings["label"], palette["muted"], 15)
        text = self._safe_text(settings["text"])
        available = max(1, width - 58)
        key = text, available
        if key not in self._wrapped:
            lines = []
            font = self._font("sans", 20)
            for paragraph in text.split("\n"):
                line = ""
                for word in re.findall(r"\S+|\s+", paragraph):
                    if line and draw.textlength(line + word, font=font) > available:
                        lines.append(line.rstrip())
                        line = ""
                        if word.isspace():
                            continue
                    for char in word:
                        if line and draw.textlength(line + char, font=font) > available:
                            lines.append(line)
                            line = ""
                        line += char
                lines.append(line)
            if len(self._wrapped) >= 128:
                self._wrapped.clear()
            self._wrapped[key] = lines
        top = 58 if settings["label"] else 27
        for index, line in enumerate(self._wrapped[key]):
            y = top + index * 28
            if y + 24 > height - 20:
                break
            self._draw_text(draw, (29, y), line, palette["text"], 20)

    def _gauge(self, draw: ImageDraw.ImageDraw, width: int, height: int,
               settings: dict, palette: dict) -> None:
        if settings.get("style", "arc") != "arc":
            self._instrument(draw, width, height, settings, palette)
            return
        if settings["label"]:
            self._draw_text(draw, (29, 27), settings["label"], palette["muted"], 15)
        value = settings["value"]
        text = "—" if value is None else gauge_number(value)
        geometry = gauge_geometry(width, height)
        radius, cx, cy, size = (geometry[key] for key in ("radius", "cx", "cy", "size"))
        if radius >= 24:
            box = (cx - radius, cy - radius, cx + radius, cy + radius)
            draw.arc(box, 150, 390, fill=palette["outline"], width=10)
            fraction = 0 if value is None else gauge_fraction(value, settings["min"], settings["max"])
            if fraction > 0:
                draw.arc(box, 150, 150 + 240 * fraction, fill=palette["primary"], width=10)
            for bound, x in ((settings["min"], cx - round(.866 * radius)), (settings["max"], cx + round(.866 * radius))):
                self._draw_text(draw, (x, cy + radius // 2 + 14), gauge_number(bound), palette["muted"], 12, "mono", "mt")
        self._value(draw, (cx, cy + math.floor(size * .36) - size + 5 if radius >= 24 else 62),
                    text, settings["unit"], palette["primary"], palette["muted"], size,
                    math.floor(size * .4), centered=True, gap=6)
        self._draw_text(draw, (cx, height - 29), settings["detail"], palette["muted"], 14, anchor="ms")

    def _instrument(self, draw: ImageDraw.ImageDraw, width: int, height: int,
                    settings: dict, palette: dict) -> None:
        geometry = instrument_geometry(width, height)
        p, available, radius, cx, cy, meter_y, size, show_shape = (geometry[key] for key in
            ("padding", "available", "radius", "cx", "cy", "meter_y", "size", "show_shape"))
        style, value = settings["style"], settings["value"]
        fraction = 0 if value is None else gauge_fraction(value, settings["min"], settings["max"])
        track, primary = palette["outline"], palette["primary"]
        if settings["label"]:
            self._draw_text(draw, (29, 27), settings["label"], palette["muted"], 15)
        value_x, value_y, value_size, centered = cx, math.floor(height * .55), size, True

        def bound(x, y, number, right=False):
            self._draw_text(draw, (x, y), gauge_number(number), palette["muted"], 12,
                            "mono", "rs" if right else "ls")

        # PIL strokes draw inward, so expand the SVG centerline box by half the stroke.
        if style == "ring" and show_shape and radius >= 24:
            box = (cx - radius - 5, cy - radius - 5, cx + radius + 5, cy + radius + 5)
            draw.ellipse(box, outline=track, width=10)
            if fraction > 0:
                draw.arc(box, -90, -90 + 360 * fraction, fill=primary, width=10)
            value_y = cy + math.floor(size * .36)
            bound(p, height - 64, settings["min"])
            bound(width - p, height - 64, settings["max"], True)
        if style in ("bar", "segments"):
            value_x, value_y, centered = p, meter_y - 16, False
            value_size = max(12, min(size, meter_y - 64))
            if show_shape:
                if style == "bar":
                    draw.rectangle((p, meter_y, p + available - 1, meter_y + 15), fill=track)
                    if fraction > 0:
                        draw.rectangle((p, meter_y, max(p, p + available * fraction - 1), meter_y + 15), fill=primary)
                    bound_y = meter_y + 38
                else:
                    for index in range(16):
                        x = p + index * available / 16
                        block_width = max(1, available / 16 - 4)
                        draw.rectangle((x, meter_y - 6, x + block_width - 1, meter_y + 21),
                                       fill=primary if index < math.floor(fraction * 16) else track)
                    bound_y = meter_y + 44
                bound(p, bound_y, settings["min"])
                bound(width - p, bound_y, settings["max"], True)
        if style == "thermometer" and show_shape:
            stem_x, stem_top, bulb_y, bulb_r = p + 20, 66, height - 82, 14
            draw.rectangle((stem_x - 6, stem_top, stem_x + 5, bulb_y), fill=track)
            draw.ellipse((stem_x - bulb_r, bulb_y - bulb_r, stem_x + bulb_r, bulb_y + bulb_r), fill=track)
            if fraction > 0:
                draw.rectangle((stem_x - 3, bulb_y - (bulb_y - stem_top) * fraction,
                                stem_x + 2, bulb_y), fill=primary)
                draw.ellipse((stem_x - 10, bulb_y - 10, stem_x + 10, bulb_y + 10), fill=primary)
            value_x = (stem_x + 28 + width - p) / 2
            value_size = max(12, min(size, math.floor((width - p - stem_x - 28) / 4)))
            bound(stem_x + 18, stem_top + 12, settings["max"])
            bound(stem_x + 18, bulb_y + 5, settings["min"])
        if style == "number":
            value_size = max(12, min(80, available // 3, value_y - 52))
            if show_shape:
                bound(p, height - 64, settings["min"])
                bound(width - p, height - 64, settings["max"], True)
        text = "—" if value is None else gauge_number(value)
        unit_size = math.floor(value_size * .4)
        value_width = draw.textlength(text, font=self._font("mono", value_size))
        unit_width = draw.textlength(self._safe_text(settings["unit"]), font=self._font("sans", unit_size))
        if centered:
            value_x -= (value_width + 6 + unit_width) / 2
        self._draw_text(draw, (value_x, value_y), text, primary, value_size, "mono", "ls")
        self._draw_text(draw, (value_x + value_width + 6, value_y), settings["unit"], palette["muted"], unit_size, anchor="ls")
        self._draw_text(draw, (cx, height - 29), settings["detail"], palette["muted"], 14, anchor="ms")

    def _storage_card(self, draw: ImageDraw.ImageDraw, width: int, height: int,
                      settings: dict, palette: dict) -> None:
        geometry = storage_geometry(width, height, settings['style'])
        table, start, stride = geometry['table'], geometry['start'], geometry['stride']
        mounts = settings['mounts']
        rows = mounts[:geometry['capacity']]
        hidden = len(mounts) - len(rows)
        padding, available = 24, max(0, width - 48)
        text = lambda x, y, value, color, size=12, anchor='ls': self._draw_text(draw, (x, y), value, palette[color], size, anchor=anchor)
        text(padding, 34, storage_short(settings['label'], max(1, available // 8)), 'text', 14)
        drives = settings.get('grouping') == 'drives'
        noun = 'drives' if drives else 'filesystems'
        state = 'sample data' if settings['sample'] else 'stale reading' if settings['stale'] else 'live · refresh 60s'
        if settings['errors'] or any(row.get('errors') for row in mounts):
            state += ' · partial data' if mounts else ' · unavailable'
        subtitle = f"{len(mounts)} {noun} · {state}" if mounts else 'Mounted storage unavailable' if settings['stale'] or settings['errors'] else 'No mounted local storage'
        text(padding, 56, storage_short(subtitle, max(1, available // 6)), 'muted')
        if table:
            for x, title, anchor in [(padding, 'Drive' if drives else 'Mount', 'ls'), (width * .63, 'Used / total', 'rs'), (width * .82, 'Free', 'rs'), (width - padding, 'Used', 'rs')]:
                text(x, 83, title, 'muted', anchor=anchor)
        for index, row in enumerate(rows):
            y = start + index * stride
            path = storage_row_name(row, settings.get('filtered', False))
            text(padding, y + 12, storage_short(path, max(1, math.floor((width * .35 - padding if table else available - 50) / 8))), 'text', 14)
            percent = row.get('usedPercent')
            valid = type(percent) in (int, float) and math.isfinite(percent) and 0 <= percent <= 100
            percent_text = f'{math.floor(percent + .5)}%' if valid else '—'
            if row.get('stale') and valid:
                percent_text += '*'
            if row.get('partial') and valid:
                percent_text += '+'
            used, total, free = (storage_size(row.get(key)) for key in ('usedGiB', 'totalGiB', 'freeGiB'))
            if row.get('partial') and row.get('usedGiB') is not None:
                used += '+'
            if table:
                text(width * .63, y + 12, f'{used} / {total}', 'muted', anchor='rs')
                text(width * .82, y + 12, free, 'muted', anchor='rs')
                text(width - padding, y + 12, percent_text, 'primary', 14, 'rs')
                draw.line((padding, y + 28, width - padding, y + 28), fill=palette['outline'])
            else:
                text(width - padding, y + 12, percent_text, 'primary', 14, 'rs')
                detail = f'{used} / {total}' + ('' if drives else f' · {free} free')
                text(padding, y + 33, storage_short(detail, max(1, math.floor(available / 6.7))), 'muted')
                if settings['style'] == 'bars' and available:
                    draw.rounded_rectangle((padding, y + 45, width - padding, y + 51), radius=3, fill=palette['outline'])
                    if valid and percent > 0:
                        draw.rounded_rectangle((padding, y + 45, padding + available * percent / 100, y + 51), radius=3, fill=palette['primary'])
        footer = f'+{hidden} {noun} · enlarge card' if hidden else '* Stale readings' if any(row.get('stale') for row in rows) else '+ Mounted usage only · GiB / TiB' if drives else 'Shared mounts grouped · GiB / TiB'
        text(padding, height - 19, storage_short(footer, max(1, math.floor(available / 6.7))), 'muted')

    def render(self, document: object, stats: object = None, palette: object = None) -> Image.Image:
        """Return RGB pixels in document dimensions, rejecting huge allocations."""
        doc = validate_layout(document)
        width, height = doc["canvas"]["width"], doc["canvas"]["height"]
        if width * height > MAX_RENDER_PIXELS:
            raise ValueError("$.canvas: rendering is limited to 16 million pixels")
        colors = doc["palette"] if palette is None else _palette(palette, "$.renderPalette")
        image = Image.new("RGB", (width, height), colors["background"])
        draw = ImageDraw.Draw(image)
        sources = {widget['settings'].get('source') for widget in doc['widgets']}
        heading = 'AI usage' if any(source and source.startswith(('codex-', 'claude-')) for source in sources) else 'Storage overview' if 'storage' in sources or any(widget['type'] == 'storage' for widget in doc['widgets']) else 'System overview'
        self._header(draw, width, stats, colors, not any(widget["type"] == "clock" for widget in doc["widgets"]), heading)
        for widget in doc["widgets"]:
            w, h = widget["width"], widget["height"]
            # The separate layer clips all glyphs and strokes to this card.
            card = Image.new("RGB", (w, h), colors["surface"])
            card_draw = ImageDraw.Draw(card)
            settings = rendered_content(widget, stats)
            if widget["type"] == "metric":
                self._metric(card_draw, w, h, settings, colors, stats)
            elif widget["type"] == "weather":
                self._weather(card_draw, w, h, settings, colors,
                              stats is not None and settings.get("source", "sample") == "weather")
            elif widget["type"] == "clock":
                if "design" in widget:
                    self._designed_text(card_draw, resolve_elements({**widget, "settings": settings}), colors)
                else:
                    self._clock(card_draw, h, settings, colors)
            elif widget["type"] == "storage":
                self._storage_card(card_draw, w, h, settings, colors)
            elif widget["type"] == "text":
                self._text_card(card_draw, w, h, settings, colors)
            else:
                self._gauge(card_draw, w, h, settings, colors)
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
