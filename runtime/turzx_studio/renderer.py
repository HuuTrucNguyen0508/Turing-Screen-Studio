"""CPU-only rendering of saved layouts, with optional caller-supplied stats."""

from __future__ import annotations

from datetime import datetime, timezone
import math
from pathlib import Path
import re

from PIL import Image, ImageDraw, ImageFont

from .card_text import card_padding
from .layout import _palette, effective_widget_palette, validate_layout
from .design import clock_time, resolve_elements
from .usage_display import USAGE_SOURCES, usage_content
from .dashboard_display import (DASHBOARD_SOURCES, dashboard_content, dashboard_rows,
                                dashboard_geometry, short_dashboard_text)
from .storage_display import storage_content, storage_geometry, storage_size, storage_short, storage_row_name
from .trend import gauge_number, trend_caption, widget_trend, trend_unit
from .image_assets import render_image
from .list_display import list_bar_role, list_content, list_layout
from .graph_display import GRAPH_AREA_MIX, graph_area, widget_graph
from .calendar_display import calendar_content, calendar_geometry, calendar_month
from .frost import FACES, FONT_DIR, FROST, ICON_AXES, ICON_FONT, LIGHT_FROM, THIN_FROM, weather_glyph
from .sheet import HAIRLINE, INK2, TRACK, Ink, baseline, facts_from, glass_layer

MAX_RENDER_PIXELS = 16_000_000
_SPARK_POINTS = (22, 23, 17, 21, 13, 16, 8, 14, 12, 19, 11, 16, 9, 13, 5, 10)
_DIGIT_RUNS = re.compile(r"\d+|\D+")
# The sheet weather block: a 144 px temperature, a glyph line and two facts. Everything under
# the figure keeps its distance from the figure's line box, so the block is 116 px taller than it.
WEATHER_FIGURE = 144
WEATHER_BLOCK = WEATHER_FIGURE + 100
# English month abbreviations for sheet copy, independent of the runtime's time locale.
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


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


def instrument_geometry(width: int, height: int) -> dict:
    padding = card_padding(width)
    available = max(1, width - 2 * padding)
    radius = math.floor(min((available - 10) / 2, (height - 128) / 2))
    return {"padding": padding, "available": available, "radius": radius,
            "cx": width / 2, "cy": 63 + radius,
            "meter_y": math.floor(63 + max(0, height - 127) * .58),
            "size": max(12, min(58, available // 4)),
            "show_shape": width >= 120 and height >= 160}


def rendered_content(widget: dict, stats: object = None, today=None) -> dict:
    """Return detached display settings without reading sensors or changing input.

    An absent source behaves as sample. Live sources use DashboardStats
    attributes and fixed decimal precision. Missing readings display an em
    dash; unavailable forecast high/low never reuse sample readings.
    """
    settings = dict(widget["settings"])
    source = settings.get("source", "sample")
    if widget["type"] == "storage":
        return storage_content(widget, getattr(stats, "ai_usage", None), preview=stats is None)
    if widget["type"] == "list":
        return list_content(settings, stats)
    if widget["type"] == "calendar":
        return calendar_content(settings, stats, today)
    if stats is None or source == "sample":
        return settings
    if source in DASHBOARD_SOURCES:
        return dashboard_content(widget, stats)
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
        if settings.get("style") == "figure":
            settings["name"], settings["facts"] = facts_from(stats, source)
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
        icon = getattr(stats, "weather_icon", None)
        if isinstance(icon, str) and icon:
            settings["icon"] = icon
        if settings.get("style") == "block":
            feels, humidity = _number(stats, "weather_feels_like_c"), _number(stats, "weather_humidity")
            settings.update(city=city, feels=None if feels is None else _format(feels),
                            humidity=None if humidity is None else _format(humidity))
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

    Fonts come only from font_dir, local DejaVu files, or Pillow's fallback,
    except under the Frost palette, which uses the shell's system Fira Sans and
    Material Symbols when installed. Stats and palette are snapshots supplied by the caller. Rendering never
    imports the original dashboard or reads scheme, sensor, or network data.
    """

    def __init__(self, font_dir: Path | None = None, ground=None) -> None:
        self.font_dir = Path(font_dir) if font_dir is not None else None
        # Optional (size, mode) -> RGB image provider for layouts with a wallpaper ground.
        self.ground = ground
        self._fonts: dict[tuple[str, int, bool], ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}
        self._wrapped: dict[tuple[str, int], list[str]] = {}
        self._ink_spans: dict[tuple[str, str, int, bool], tuple[int, int]] = {}
        # Set per render from the palette; renders are serialized by their callers.
        self._frost = False

    def _frost_font(self, family: str, size: int) -> ImageFont.FreeTypeFont | None:
        """Fira Sans: thin for large figures, light for large words, medium for names."""
        face = ("thin" if family == "mono" and size >= THIN_FROM else
                "medium" if family == "medium" else
                "light" if size >= LIGHT_FROM else "regular")
        try:
            return ImageFont.truetype(str(FONT_DIR / FACES[face]), size)
        except OSError:
            return None

    def _font(self, family: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        key = family, size, self._frost
        if key not in self._fonts:
            summary_font = family.startswith("summary-")
            family = family.removeprefix("summary-")
            if self._frost:
                font = self._frost_font(family, size)
                if font is not None:
                    self._fonts[key] = font
                    return font
            # Medium names fall back to the regular face outside Frost.
            family = "sans" if family == "medium" else family
            candidates = []
            if self.font_dir is not None:
                relative = {
                    "mono": "jetbrains-mono/JetBrainsMono-Regular.ttf",
                    "sans": "roboto/Roboto-Regular.ttf",
                }[family]
                candidates.append(self.font_dir / relative)
            if summary_font:
                candidates.append(Path(__file__).resolve().parents[2] / 'public/fonts' / (
                    'JetBrainsMono-Regular.ttf' if family == 'mono' else 'Roboto-Regular.ttf'))
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

    def _runs(self, text: str) -> list[tuple[str, list[str] | None]]:
        """Frost sets digits in tabular figures so live readings keep their width.
        Separators stay proportional: tabular colons and points open wide gaps."""
        if not self._frost:
            return [(text, None)]
        return [(run, ["tnum"] if run[0].isdigit() else None) for run in _DIGIT_RUNS.findall(text)]

    def _tracking(self, family: str, size: int) -> float:
        """Frost tightens its thin figures like the shell: -0.03 em, -0.035 em from 80 px."""
        if not self._frost or family.removeprefix("summary-") != "mono" or size < THIN_FROM:
            return 0
        return -(.035 if size >= 80 else .03) * size

    def _length(self, draw: ImageDraw.ImageDraw, text: str, family: str, size: int) -> float:
        font = self._font(family, size)
        text = self._safe_text(text)
        return (sum(draw.textlength(run, font=font, features=features) for run, features in self._runs(text))
                + self._tracking(family, size) * max(0, len(text) - 1))

    def _draw_text(self, draw: ImageDraw.ImageDraw, xy: tuple[float, float],
                   text: str, color: str, size: int, family: str = "sans",
                   anchor: str = "lt") -> None:
        text = self._safe_text(text)
        font = self._font(family, size)
        runs = self._runs(text)
        track = self._tracking(family, size)
        if len(runs) < 2 and runs and runs[0][1] is None and not track:
            draw.text(xy, text, font=font, fill=color, anchor=anchor)
            return
        x, y = xy
        if anchor[0] in "mr":
            width = self._length(draw, text, family, size)
            x -= width / 2 if anchor[0] == "m" else width
        # Top and middle anchors measure each string's own ink, so a lone "." would rise:
        # place the whole string once, then set every run on its baseline.
        y += font.getbbox(text, anchor="l" + anchor[1])[1] - font.getbbox(text, anchor="ls")[1]
        for run, features in runs:
            for piece in (run if track else (run,)):
                draw.text((x, y), piece, font=font, fill=color, anchor="ls", features=features)
                x += draw.textlength(piece, font=font, features=features) + track

    def _value(self, draw: ImageDraw.ImageDraw, xy: tuple[float, float], value: str,
               unit: str, color: str, unit_color: str, size: int, unit_size: int,
               centered: bool = False, gap: int = 9) -> None:
        value = self._safe_text(value)
        unit = self._safe_text(unit)
        value_width = self._length(draw, value, "mono", size)
        unit_width = self._length(draw, unit, "sans", unit_size)
        x, y = xy
        if centered:
            x -= (value_width + gap + unit_width) / 2
        self._draw_text(draw, (x, y), value, color, size, "mono")
        self._draw_text(draw, (x + value_width + gap, y + size - unit_size),
                        unit, unit_color, unit_size)

    def _metric(self, draw: ImageDraw.ImageDraw, width: int, height: int,
                settings: dict, palette: dict, stats: object = None) -> None:
        if settings.get('source') in DASHBOARD_SOURCES:
            self._dashboard_metric(draw, width, height, settings, palette)
            return
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
        value_width = self._length(draw, settings['value'], 'mono', size)
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

    def _weather_glyph(self, draw: ImageDraw.ImageDraw, cx: float, top: int,
                       settings: dict, palette: dict) -> bool:
        """Draw the shell's outlined Material Symbols glyph in the line icon's 112 x 84 box."""
        key = "icon", 88, True
        if key not in self._fonts:
            try:
                font = ImageFont.truetype(str(FONT_DIR / ICON_FONT), 88)
                font.set_variation_by_axes(list(ICON_AXES))
            except (OSError, ValueError):
                return False
            self._fonts[key] = font
        font = self._fonts[key]
        glyph = weather_glyph(settings.get("icon"), settings["condition"])
        draw.text((cx, top + 42), glyph, font=font, fill=palette["text"], anchor="mm")
        return True

    def _weather(self, draw: ImageDraw.ImageDraw, width: int, height: int,
                 settings: dict, palette: dict, live: bool) -> None:
        center = width / 2
        self._draw_text(draw, (29, 27), f"Weather / {settings['location']}", palette["muted"], 15)
        if not (self._frost and self._weather_glyph(draw, center, 69, settings, palette)):
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

    def _dashboard_metric(self, draw, width, height, settings, palette):
        data = dashboard_rows(settings['detail'])
        geometry = dashboard_geometry(width, height, settings['source'])
        p, top, stride, capacity, available = (geometry[key] for key in ('padding', 'top', 'stride', 'capacity', 'available'))
        short = short_dashboard_text
        def text(x, y, value, size=13, role='muted', mono=False, end=False):
            self._draw_text(draw, (x, y), value, palette[role], size,
                            'summary-mono' if mono else 'summary-sans', 'rs' if end else 'ls')
        if settings['source'] == 't3-threads':
            compact = height < 132
            count = '—' if data['working'] is None else str(data['working'])
            size = max(12, min(36 if compact else 48, math.floor((available - (0 if data['working'] is None else 88)) / max(1, len(count) * .6))))
            text(p, 25 if compact else 40, short(settings['label'], available, 15), 15)
            text(p, 76 if compact else 98, count, size, 'muted' if data['working'] is None else 'primary', True)
            if data['working'] is not None:
                text(p + len(count) * size * .6 + 8, 76 if compact else 98, 'working', 20)
            if not compact:
                text(p, 124, short(data['note'] or 'Activity unavailable', available, 13))
            if capacity > 0 and width - p > p:
                draw.line((p, 140, width - p, 140), fill=palette['outline'])
            overflow = len(data['threads']) > capacity
            shown = data['threads'][:max(0, capacity - 1) if overflow else capacity]
            providers = {'codex-pro': 'Codex Pro', 'codex': 'Codex', 'claudeAgent': 'Claude', 'cursor': 'Cursor'}
            statuses = {'running': 'Working', 'waiting_approval': 'Needs approval', 'waiting_input': 'Needs input', 'waiting': 'Waiting'}
            for index, row in enumerate(shown):
                y = top + index * stride
                self._draw_text(draw, (p, y), short(row['title'], available, 16), palette['text'], 16,
                                'medium' if self._frost else 'summary-sans', 'ls')
                running = row['status'] == 'running'
                draw.ellipse((p + 1, y + 11, p + 7, y + 17), outline=palette['primary' if running else 'muted'], fill=palette['primary'] if running else None)
                text(p + 14, y + 18, statuses.get(row['status'], 'Waiting'))
                if width >= 230:
                    text(width - p, y + 18, short(providers.get(row['provider'], row['provider']), 78, 12, True), 12, 'secondary', True, True)
            if overflow and capacity > 0:
                text(p, top + len(shown) * stride, 'More threads in T3', 12)
            if data['working'] == 0 and not data['threads'] and capacity > 0:
                text(p, top, short('No threads working', available, 14), 14)
            return
        text(p, 40, short(settings['label'], max(1, available - 62), 15), 15)
        if width >= 230:
            text(width - p, 40, 'Sample' if data['note'].startswith('Sample') else 'Estimated', 13, end=True)
        if capacity == 0:
            text(p, 76, short('Enlarge card to show timers', available, 13))
            return
        for index, row in enumerate(data['games'][:capacity]):
            y = top + stride * index
            count = '—' if row['current'] is None else str(row['current'])
            cap = '/' + ('—' if row['capacity'] is None else str(row['capacity']))
            number_x = width - p - len(cap) * 14 * .6 - 2
            name_width = max(1, number_x - len(count) * 24 * .6 - p - 12)
            fraction = min(1, row['current'] / row['capacity']) if row['current'] is not None and row['capacity'] is not None and row['capacity'] > 0 else 0
            full = stride >= 72
            baseline, bar_y = y + (34 if full else 24), y + (44 if full else 32)
            text(p, baseline, short(row['name'], name_width, 16), 16, 'text')
            text(number_x, baseline, count, 24, 'muted' if row['current'] is None else 'secondary', True, True)
            text(width - p, baseline, cap, 14, mono=True, end=True)
            draw.rounded_rectangle((p, bar_y, p + available - 1, bar_y + 3), radius=2, fill=palette['outline'])
            fill = math.floor(available * fraction + .5)
            if fill > 0:
                draw.rounded_rectangle((p, bar_y, p + fill - 1, bar_y + 3), radius=2, fill=palette['secondary'])
            if full:
                text(p, y + 66, short(row['remaining'] or 'Timer unavailable', available - (80 if row['age'] else 0), 13))
                if row['age']:
                    text(width - p, y + 66, row['age'], 12, end=True)
        if not data['games']:
            text(p, 92, short('Set counts in Game timers', available, 14), 14)

    def _usage_metric(self, draw, width, height, settings, palette):
        if settings['source'] in ('usage-tokens-30d', 'usage-cost-30d', 'usage-limits'):
            self._usage_summary(draw, width, height, settings, palette)
            return
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

    def _usage_summary(self, draw, width, height, settings, palette):
        lines = self._safe_text(settings['detail']).split('\n')
        note = lines[0] if lines else ''
        short = lambda value, available, size: storage_short(value, max(1, math.floor(available / (size * .55))))
        def text(x, y, value, size=14, role='muted', family='sans', anchor='ls'):
            self._draw_text(draw, (x, y), value, palette[role], size, 'summary-' + family, anchor)
        p = 28
        text(p, 40, settings['label'] + (' · Usage left' if settings['source'] == 'usage-limits' else ''), 15)
        if settings['source'] == 'usage-limits':
            rows = [line.split('\t') for line in lines[1:9] if len(line.split('\t')) == 5 and line.split('\t')[0] in ('Codex', 'Claude')][:4]
            label_x, bar_x, bar_end = math.floor(width * .128), math.floor(width * .222), math.floor(width * .639)
            value_x, caption_x = math.floor(width * .712), math.floor(width * .75)
            stride = min(60, max(1, math.floor((height - 100) / 4)))
            previous = None
            for index, (provider, window, raw, reset, state) in enumerate(rows):
                top = 64 + stride * index
                if provider != previous:
                    if index:
                        draw.line((p, top, width - p, top), fill=palette['outline'])
                    text(p, top + 38, provider, 17, 'text')
                previous = provider
                text(label_x, top + 37, window, 15)
                try:
                    percent = float(raw)
                except ValueError:
                    percent = math.nan
                known = math.isfinite(percent) and 0 <= percent <= 100 and 'reset time passed' not in reset
                if known:
                    percent = 100 - percent
                if bar_end > bar_x:
                    draw.rounded_rectangle((bar_x, top + 27, bar_end - 1, top + 34), radius=4, fill=palette['outline'])
                    fill = math.floor((bar_end - bar_x) * percent / 100 + .5) if known else 0
                    if fill > 0:
                        draw.rounded_rectangle((bar_x, top + 27, bar_x + fill - 1, top + 34), radius=4, fill=palette['primary'])
                text(value_x, top + 40, str(math.floor(percent + .5)) if known else '—', 24, 'primary' if known else 'muted', 'mono', 'rs')
                if known:
                    text(value_x + 4, top + 40, '%')
                text(caption_x, top + 29, short(reset, width - p - caption_x, 14))
                text(caption_x, top + 47, short(state, width - p - caption_x, 12), 12)
            text(p, height - 20, short(note + '. Missing data is not zero.', width - p * 2, 12), 12)
            return
        rows = [line.split('\t') for line in lines[1:9] if len(line.split('\t')) == 3 and line.split('\t')[0] in ('Codex', 'Claude', 'Cursor')][:3]
        unit = '' if settings['value'] == '—' else settings['unit']
        size = max(12, min(56, math.floor((width - p * 2 - len(unit) * 22 * .55 - 8) / max(1, len(settings['value']) * .6))))
        text(width - p, 40, 'Last 30 days', 15, anchor='rs')
        text(p, 112, settings['value'], size, 'muted' if settings['value'] == '—' else 'primary', 'mono')
        text(p + len(settings['value']) * size * .6 + 8, 112, unit, 22)
        caption = note.replace(' · Last 30 days', '').replace('Last 30 days · ', '').split(' · ')
        state = caption.pop() if len(caption) > 1 else ''
        text(p, 138, short(' · '.join(caption), width - p * 2, 12), 12)
        text(p, 156, short(state, width - p * 2, 12), 12)
        draw.line((p, 166, width - p, 166), fill=palette['outline'])
        amounts = []
        for _, value, _ in rows:
            match = re.match(r'(\d+(?:\.\d+)?)([KMB]?)', value.replace(',', ''))
            number = float(match[1]) * {'': 1, 'K': 1e3, 'M': 1e6, 'B': 1e9}[match[2]] if match else 0
            amounts.append(number if math.isfinite(number) else 0)
        total = sum(amounts)
        bar_x, bar_end = 120, max(120, width - 140)
        for index, (provider, value, _) in enumerate(rows):
            y = 202 + index * 36
            text(p, y, provider, 17, 'text')
            if bar_end > bar_x:
                draw.rounded_rectangle((bar_x, y - 9, bar_end - 1, y - 6), radius=2, fill=palette['outline'])
                fill = math.floor((bar_end - bar_x) * amounts[index] / total + .5) if total > 0 else 0
                if fill > 0:
                    draw.rounded_rectangle((bar_x, y - 9, bar_x + fill - 1, y - 6), radius=2, fill=palette['secondary'])
            text(width - p, y, short(value, 112, 18), 18, 'text', 'mono', 'rs')

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

    def _designed_x(self, draw: ImageDraw.ImageDraw, element: dict, text: str) -> float:
        """Where a designed element's text starts. Frost sets start-aligned text by its ink,
        so a 176 px figure and a 24 px date share one left edge whatever their side bearings."""
        if self._frost and element["align"] == "start":
            return element["x"] - self._ink_span(draw, text, element["family"], element["size"])[0]
        return element["x"]

    def _designed_text(self, draw: ImageDraw.ImageDraw, elements: list[dict], palette: dict) -> None:
        for element in elements:
            if element["hidden"]:
                continue
            text = self._safe_text(element["text"])
            x, y = self._designed_x(draw, element, text), element["y"]
            color = element["color"] if element["color"].startswith("#") else palette[element["color"]]
            size, family = element["size"], element["family"]
            suffix = self._safe_text(element.get("suffix", ""))
            if suffix:
                digits_width = self._length(draw, text, family, size)
                suffix_size, gap = element["suffixSize"], element["gap"]
                width = digits_width + gap + self._length(draw, suffix, "sans", suffix_size)
                left = x - (width / 2 if element["align"] == "center" else width if element["align"] == "end" else 0)
                self._draw_text(draw, (left, y), text, color, size, family, "ls")
                suffix_color = element.get("suffixColor", "muted")
                suffix_color = suffix_color if suffix_color.startswith("#") else palette[suffix_color]
                self._draw_text(draw, (left + digits_width + gap, y), suffix, suffix_color, suffix_size, "sans", "ls")
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
            fraction = 0 if value is None else gauge_fraction(value, settings["min"], settings["max"])
            if self._frost:
                self._frost_arc(draw, cx, cy, radius, 150, 390, palette["outline"])
                if fraction > 0:
                    self._frost_arc(draw, cx, cy, radius, 150, 150 + 240 * fraction, palette["primary"])
            else:
                draw.arc(box, 150, 390, fill=palette["outline"], width=10)
                if fraction > 0:
                    draw.arc(box, 150, 150 + 240 * fraction, fill=palette["primary"], width=10)
            for bound, x in ((settings["min"], cx - round(.866 * radius)), (settings["max"], cx + round(.866 * radius))):
                self._draw_text(draw, (x, cy + radius // 2 + 14), gauge_number(bound), palette["muted"], 12, "mono", "mt")
        self._value(draw, (cx, cy + math.floor(size * .36) - size + 5 if radius >= 24 else 62),
                    text, settings["unit"], palette["primary"], palette["muted"], size,
                    math.floor(size * .4), centered=True, gap=6)
        self._draw_text(draw, (cx, height - 29), settings["detail"], palette["muted"], 14, anchor="ms")

    @staticmethod
    def _frost_arc(draw: ImageDraw.ImageDraw, cx: float, cy: float, radius: int,
                   start: float, end: float, color: str, stroke: int = 6) -> None:
        """A Frost meter bent into the arc: a thin stroke with round caps, centred on the
        10 px arc's midline so the gauge keeps its geometry."""
        middle = radius - 5
        outer = middle + stroke / 2
        draw.arc((cx - outer, cy - outer, cx + outer, cy + outer), start, end, fill=color, width=stroke)
        for angle in (start, end):
            x = cx + middle * math.cos(math.radians(angle))
            y = cy + middle * math.sin(math.radians(angle))
            draw.ellipse((x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2), fill=color)

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
        value_width = self._length(draw, text, "mono", value_size)
        unit_width = self._length(draw, settings["unit"], "sans", unit_size)
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
            self._draw_text(draw, (padding, y + 12), storage_short(path, max(1, math.floor((width * .35 - padding if table else available - 50) / 8))),
                            palette['text'], 14, 'medium', 'ls')
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
                    # Frost's meter is 4 px, centred where the 6 px bar sat
                    top, bottom, round_ = (y + 46, y + 50, 2) if self._frost else (y + 45, y + 51, 3)
                    draw.rounded_rectangle((padding, top, width - padding, bottom), radius=round_, fill=palette['outline'])
                    if valid and percent > 0:
                        draw.rounded_rectangle((padding, top, padding + available * percent / 100, bottom),
                                               radius=round_, fill=palette['primary'])
        footer = f'+{hidden} {noun} · enlarge card' if hidden else '* Stale readings' if any(row.get('stale') for row in rows) else '+ Mounted usage only · GiB / TiB' if drives else 'Shared mounts grouped · GiB / TiB'
        text(padding, height - 19, storage_short(footer, max(1, math.floor(available / 6.7))), 'muted')

    @staticmethod
    def _mix(color: str, base: str, amount: float) -> str:
        channels = [round(int(base[i:i + 2], 16) + (int(color[i:i + 2], 16) - int(base[i:i + 2], 16)) * amount)
                    for i in (1, 3, 5)]
        return '#' + ''.join(f'{channel:02x}' for channel in channels)

    def _kicker(self, draw: ImageDraw.ImageDraw, x: int, text: str, palette: dict) -> None:
        if text:
            self._draw_text(draw, (x, 42), text, palette['muted'], 15, 'summary-sans', 'ls')

    def _reading(self, draw: ImageDraw.ImageDraw, xy: tuple[float, float], value: str, unit: str,
                 color: str, unit_color: str, size: int, unit_size: int, gap: int, anchor: str = 'ls') -> None:
        """A mono value and sans unit sharing one baseline; 'rs' right-aligns the whole run."""
        x, y = xy
        value_width = self._length(draw, value, 'summary-mono', size)
        unit_width = self._length(draw, unit, 'summary-sans', unit_size) if unit else 0
        if anchor == 'rs':
            x -= value_width + (gap + unit_width if unit else 0)
        self._draw_text(draw, (x, y), value, color, size, 'summary-mono', 'ls')
        if unit:
            self._draw_text(draw, (x + value_width + gap, y), unit, unit_color, unit_size, 'summary-sans', 'ls')

    def _list_card(self, draw: ImageDraw.ImageDraw, width: int, height: int,
                   settings: dict, palette: dict) -> None:
        layout = list_layout(width, height, settings['label'], settings['rows'], settings['bars'])
        left, right = layout['padding'], width - layout['padding']
        self._kicker(draw, left, layout['kicker'], palette)
        for source, row in zip((row['source'] for row in settings['rows']), layout['rows']):
            y = row['baseline']
            self._draw_text(draw, (left, y), row['label'], palette['text'], layout['labelSize'], 'summary-sans', 'ls')
            self._reading(draw, (right, y), row['value'], row['unit'], palette['text'], palette['muted'],
                          layout['valueSize'], layout['unitSize'], 4, 'rs')
            if row['barY'] is not None and right > left:
                bar = row['barY']
                draw.rounded_rectangle((left, bar, right - 1, bar + 5), radius=3, fill=palette['outline'])
                fill = math.floor((right - left) * row['fraction'] + .5)
                if fill > 0:
                    draw.rounded_rectangle((left, bar, left + fill - 1, bar + 5), radius=3,
                                           fill=palette[list_bar_role(source)])

    def _graph_card(self, draw: ImageDraw.ImageDraw, width: int, height: int,
                    settings: dict, palette: dict, stats: object) -> None:
        chart = widget_graph(settings, stats, width, height)
        left, right = chart['left'], chart['right']
        self._kicker(draw, left, chart['kicker'], palette)
        for series in chart['series']:
            legend, color = series['legend'], palette[series['role']]
            if legend['nameY'] is not None:
                swatch = (legend['x'], legend['nameY'] - 10, legend['x'] + 9, legend['nameY'] - 1)
                if series['primary']:
                    draw.rectangle(swatch, fill=color)
                else:
                    draw.rectangle(swatch, outline=color, width=2)
                self._draw_text(draw, (legend['x'] + 16, legend['nameY']), series['name'], palette['muted'], 13, 'summary-sans', 'ls')
            self._reading(draw, (legend['x'], legend['valueY']), series['reading']['value'], series['reading']['unit'],
                          color, palette['muted'], legend['valueSize'], legend['unitSize'], 6)
        if chart['showChart']:
            self._draw_text(draw, (right, chart['rangeY']), chart['range'], palette['muted'], 11, 'summary-sans', 'rs')
            for y in (chart['top'], chart['middle'], chart['bottom']):
                draw.line((left, y, right, y), fill=palette['outline'])
            if settings['style'] == 'area':
                series = chart['series'][0]
                fill = self._mix(palette[series['role']], palette['surface'], GRAPH_AREA_MIX)
                for points in series['segments']:
                    if len(points) > 1:
                        draw.polygon([(point['x'], point['y']) for point in graph_area(points, chart['bottom'])], fill=fill)
            for series in chart['series']:
                color = palette[series['role']]
                for points in series['lines']:
                    draw.line([(point['x'], point['y']) for point in points], fill=color, width=2 if series['primary'] else 1)
                for points in series['segments']:
                    if len(points) == 1:
                        x, y = points[0]['x'], points[0]['y']
                        draw.ellipse((x - 1, y - 1, x + 1, y + 1), fill=color)
            for series in chart['series']:
                if series['last']:
                    x, y = series['last']['x'], series['last']['y']
                    draw.ellipse((x - 6, y - 6, x + 6, y + 6), fill=palette['surface'])
                    if series['primary']:
                        draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=palette[series['role']])
                    else:
                        draw.ellipse((x - 4, y - 4, x + 4, y + 4), outline=palette[series['role']], width=2)
            if chart['state']:
                self._draw_text(draw, (left, chart['middle'] - 8), chart['state'], palette['muted'], 13, 'summary-sans', 'ls')
        self._draw_text(draw, (left, chart['captionY']), trend_caption(stats is None), palette['muted'], 12, 'summary-sans', 'ls')

    def _calendar_card(self, draw: ImageDraw.ImageDraw, width: int, height: int,
                       settings: dict, palette: dict) -> None:
        month = calendar_month(settings['date'], settings['weekStart'])
        g = calendar_geometry(width, height, settings['label'], len(month['weeks']) if month else 6)
        self._kicker(draw, g['padding'], g['kicker'], palette)
        if month is None:
            self._draw_text(draw, (g['padding'], g['titleY']), 'Date unavailable', palette['muted'], 15, 'summary-sans', 'ls')
            return
        self._draw_text(draw, (g['padding'], g['titleY']), month['title'], palette['text'], g['titleSize'], 'summary-sans', 'ls')
        self._draw_text(draw, (width - g['padding'], g['titleY']), month['year'], palette['muted'], 15, 'summary-mono', 'rs')
        if not g['showGrid']:
            return
        cell_width, cell_height = g['cellWidth'], g['cellHeight']
        for column, weekday in enumerate(month['weekdays']):
            self._draw_text(draw, (g['gridLeft'] + column * cell_width + cell_width // 2, g['headerY']),
                            weekday['name'], palette['muted'], 12, 'summary-sans', 'ms')
        for row, week in enumerate(month['weeks']):
            top = g['gridTop'] + row * cell_height
            for column, day in enumerate(week):
                if day is None:
                    continue
                cell_left = g['gridLeft'] + column * cell_width
                color = palette['muted'] if month['weekdays'][column]['weekend'] else palette['text']
                if day == month['today']:
                    draw.rounded_rectangle((cell_left + 2, top + 2, cell_left + cell_width - 3, top + cell_height - 3),
                                           radius=g['todayRadius'], fill=palette['primary'])
                    color = palette['surface']
                self._draw_text(draw, (cell_left + cell_width // 2, top + cell_height // 2 + math.floor(g['daySize'] * .36)),
                                str(day), color, g['daySize'], 'summary-mono', 'ms')

    # Frost sheet variants: left-aligned readings drawn straight onto the fog or a glass slab.
    # Box tops and line boxes follow the design spec; baseline() converts them to PIL baselines.

    def _fit(self, draw: ImageDraw.ImageDraw, text: str, family: str, size: int, width: float) -> str:
        text = self._safe_text(text)
        if self._length(draw, text, family, size) <= width:
            return text
        while text and self._length(draw, text + "…", family, size) > width:
            text = text[:-1]
        return text.rstrip() + "…"

    def _ink_text(self, ink: Ink, xy: tuple[float, float], text: str, size: int,
                  family: str = "sans", alpha: float = 1.0, anchor: str = "ls") -> float:
        draw, fill = ink.target(alpha)
        self._draw_text(draw, xy, text, fill, size, family, anchor)
        return self._length(draw, text, family, size)

    def _figure_x(self, draw: ImageDraw.ImageDraw, figure: str, above: str, family: str, size: int, left: float = 0) -> float:
        """x for a 56 px thin figure so its ink starts where the line above it does: the digits'
        side bearing is 3 to 6 px, the label's about 1."""
        return left + self._ink_span(draw, above, family, size)[0] - self._ink_span(draw, figure, "mono", 56)[0]

    def _sheet_figure(self, ink: Ink, draw: ImageDraw.ImageDraw, width: int, settings: dict) -> None:
        """Title, device name, a 56 px figure, up to two "value word" facts and a 3 px meter."""
        value = settings["value"]
        label = self._fit(draw, settings["label"], "medium", 15, width)
        self._ink_text(ink, (0, baseline(0, 20, 15)), label, 15, "medium")
        if settings.get("name"):
            self._ink_text(ink, (0, baseline(20, 20, 14)), self._fit(draw, settings["name"], "sans", 14, width), 14, alpha=INK2)
        unit = settings["unit"]
        figure = "—" if value is None else f"{math.floor(value + .5)}{unit if unit in ('%', '') else ' ' + unit}"
        self._ink_text(ink, (self._figure_x(draw, figure, label, "medium", 15), baseline(48, 56, 56)), figure, 56, "mono")
        facts = settings.get("facts")
        if facts is None:
            facts = [(settings["detail"], "")] if settings["detail"] else []
        for index, (amount, word) in enumerate(facts[:2]):
            self._fact(ink, draw, (0, baseline(112 + index * 20, 20, 14)), amount, word, width)
        fraction = 0 if value is None else gauge_fraction(value, settings["min"], settings["max"])
        ink.bar((0, 160, width, 163), TRACK)
        ink.bar((0, 160, round(width * fraction), 163))

    def _sheet_storage(self, ink: Ink, draw: ImageDraw.ImageDraw, width: int, settings: dict) -> None:
        """Storage as columns: name and share, meter, used of total, free."""
        self._ink_text(ink, (0, baseline(0, 20, 15)), self._fit(draw, settings["label"], "medium", 15, width), 15, "medium")
        rows = settings["mounts"]
        if not rows:
            self._ink_text(ink, (0, baseline(28, 20, 14)), "Mounted storage unavailable", 14, alpha=INK2)
            return
        columns = min(len(rows), max(1, (width + 24) // 208))
        column = (width - 24 * (columns - 1)) // columns
        for index, row in enumerate(rows[:columns]):
            left = index * (column + 24)
            percent = row.get("usedPercent")
            valid = type(percent) in (int, float) and math.isfinite(percent) and 0 <= percent <= 100
            share = (f"{math.floor(percent + .5)}%" + ("*" if row.get("stale") else "") + ("+" if row.get("partial") else "")
                     if valid else "—")
            y = baseline(28, 20, 14)
            share_width = self._length(draw, share, "medium", 14)
            name = self._fit(draw, storage_row_name(row, settings.get("filtered", False)), "medium", 14, column - share_width - 8)
            self._ink_text(ink, (left, y), name, 14, "medium")
            self._ink_text(ink, (left + column, y), share, 14, "medium", anchor="rs")
            ink.bar((left, 54, left + column, 57), TRACK)
            if valid:
                ink.bar((left, 54, left + round(column * percent / 100), 57))
            used, total, free = (storage_size(row.get(key)) for key in ("usedGiB", "totalGiB", "freeGiB"))
            if row.get("partial") and row.get("usedGiB") is not None:
                used += "+"
            used_number, _, used_unit = used.partition(" ")
            detail = f"{used_number} of {total}" if used_unit and total.endswith(" " + used_unit) else f"{used} of {total}"
            self._ink_text(ink, (left, baseline(64, 20, 14)), self._fit(draw, detail, "sans", 14, column), 14, alpha=INK2)
            self._ink_text(ink, (left, baseline(84, 20, 14)), self._fit(draw, f"{free} free", "sans", 14, column), 14, alpha=INK2)

    def _sheet_threads(self, ink: Ink, draw: ImageDraw.ImageDraw, width: int, height: int, settings: dict) -> None:
        """Threads: a title with the working count, then one line per thread."""
        data = dashboard_rows(settings["detail"])
        title_width = self._ink_text(ink, (0, baseline(0, 20, 15)), self._fit(draw, settings["label"], "medium", 15, width / 2), 15, "medium")
        capacity = max(0, (height - 30 + 12) // 36)
        threads = data["threads"]
        shown = threads[:capacity]
        count = ("Activity unavailable" if data["working"] is None else f"{data['working']} working")
        self._ink_text(ink, (max(76, title_width + 16), baseline(0, 20, 14)), count, 14, alpha=INK2)
        # The collector lists a bounded number of threads; the working count can be larger.
        hidden = max(len(threads), data["working"] or 0) - len(shown)
        if hidden > 0 and shown:
            self._ink_text(ink, (width, baseline(0, 20, 14)), f"{hidden} more in T3", 14, alpha=INK2, anchor="rs")
        statuses = {"running": "Working", "waiting_approval": "Needs approval", "waiting_input": "Needs input", "waiting": "Waiting"}
        providers = {"codex-pro": "Codex Pro", "codex": "Codex", "claudeAgent": "Claude", "cursor": "Cursor"}
        if not shown and capacity:
            self._ink_text(ink, (0, baseline(30, 24, 14)), "No threads working", 14, alpha=INK2)
        for index, row in enumerate(shown):
            top = 30 + index * 36
            self._ink_text(ink, (0, baseline(top, 24, 15)), self._fit(draw, row["title"], "medium", 15, min(400, width - 200)), 15, "medium")
            self._ink_text(ink, (width - 90, baseline(top, 24, 14)), statuses.get(row["status"], "Waiting"), 14, alpha=INK2, anchor="rs")
            provider = providers.get(row["provider"], row["provider"])
            self._ink_text(ink, (width, baseline(top, 24, 14)), self._fit(draw, provider, "sans", 14, 70), 14, alpha=INK2, anchor="rs")

    def _fact(self, ink: Ink, draw: ImageDraw.ImageDraw, xy: tuple[float, float], amount: str, word: str, width: float) -> None:
        """One "value word" fact: the value in medium ink, the word after a two-space gap in ink2."""
        x, y = xy
        used = self._ink_text(ink, (x, y), self._fit(draw, amount, "medium", 14, width), 14, "medium") if amount else 0
        gap = draw.textlength("\u00a0 ", font=self._font("sans", 14)) if amount else 0
        if word and used + gap < width:
            self._ink_text(ink, (x + used + gap, y), self._fit(draw, word, "sans", 14, width - used - gap), 14, alpha=INK2)

    def _sheet_limits(self, ink: Ink, draw: ImageDraw.ImageDraw, width: int, settings: dict) -> None:
        """Quota limits as figure columns: provider over its first window, the window name,
        the used share, the time until reset and a 3 px meter."""
        lines = settings["detail"].split("\n")
        rows = [line.split("\t") for line in lines[1:9]]
        rows = [row for row in rows if len(row) == 5 and row[0] in ("Codex", "Claude")][:4]
        if not rows:
            self._ink_text(ink, (0, baseline(0, 20, 15)), self._fit(draw, settings["label"], "medium", 15, width), 15, "medium")
            self._ink_text(ink, (0, baseline(20, 20, 14)), "Quota limits unavailable", 14, alpha=INK2)
            return
        # The collector calls a limit stale after five minutes; the sheet dates only readings over an hour old.
        observed = settings.get("observed")
        dated = (type(observed) in (int, float) and math.isfinite(observed)
                 and datetime.now(timezone.utc).timestamp() - observed > 3600)
        column = (width - 24 * (len(rows) - 1)) // len(rows)
        previous = None
        for index, (provider, window, display, reset, state) in enumerate(rows):
            left = index * (column + 24)
            above, above_family, above_size = self._fit(draw, window, "sans", 14, column), "sans", 14
            if provider != previous:
                above, above_family, above_size = self._fit(draw, provider, "medium", 15, column), "medium", 15
                self._ink_text(ink, (left, baseline(0, 20, 15)), above, 15, "medium")
            previous = provider
            self._ink_text(ink, (left, baseline(20, 20, 14)), self._fit(draw, window, "sans", 14, column), 14, alpha=INK2)
            try:
                percent = float(display)
            except ValueError:
                percent = None
            known = percent is not None and math.isfinite(percent) and 0 <= percent <= 100
            reading = f"{math.floor(percent + .5)}%" if known else "–"
            self._ink_text(ink, (self._figure_x(draw, reading, above, above_family, above_size, left), baseline(48, 56, 56)), reading, 56, "mono")
            estimate = reset.endswith(" · estimate")
            reset = reset.removesuffix(" · estimate")
            if not known:
                amount, word = "", "unavailable"
            elif reset.startswith("resets "):
                amount, word = ("~" if estimate else "") + reset.removeprefix("resets "), "until reset"
            elif reset.startswith("reset time passed"):
                amount, word = "", "reset pending"
            else:
                amount, word = "", "reset unknown"
            self._fact(ink, draw, (left, baseline(112, 20, 14)), amount, word, column)
            if known and "stale" in state and dated:
                self._fact(ink, draw, (left, baseline(132, 20, 14)), "", f"as of {datetime.fromtimestamp(observed):%H:%M}", column)
            ink.bar((left, 160, left + column, 163), TRACK)
            if known:
                ink.bar((left, 160, left + round(column * percent / 100), 163))

    @staticmethod
    def _dollars(amount: str) -> str:
        """Whole US dollars with a thin space between thousands: "$2 032"."""
        partial = amount.endswith("+")
        try:
            value = math.floor(float(amount.removesuffix("+")) + .5)
        except ValueError:
            return "—"
        return "$" + f"{value:,}".replace(",", "\u2009") + ("+" if partial else "")

    def _sheet_total(self, ink: Ink, draw: ImageDraw.ImageDraw, width: int, settings: dict) -> None:
        """A 30-day total: title, period, a 56 px figure and one fact per provider beside it."""
        cost = settings["source"] == "usage-cost-30d"
        lines = settings["detail"].split("\n")
        note = lines[0]
        rows = [line.split("\t") for line in lines[1:9]]
        rows = [row for row in rows if len(row) == 3 and row[0] in ("Codex", "Claude", "Cursor")][:3]
        value = str(settings["value"])
        label = self._fit(draw, settings["label"], "medium", 15, width)
        self._ink_text(ink, (0, baseline(0, 20, 15)), label, 15, "medium")
        if value in ("—", ""):
            figure, name = "—", "API estimate unavailable" if cost else "Usage unavailable"
        else:
            # An incomplete total says "Partial" in its name rather than "+" on the figure.
            value = value.removesuffix("+")
            if cost:
                figure = self._dollars(value)
            else:
                figure = value + (settings["unit"][:1] if settings["unit"][:1] in ("K", "M", "B") else "")
            period = "API estimate, last 30 days" if cost else "Last 30 days"
            if note.startswith("Partial"):
                period = "Partial estimate, last 30 days" if cost else "Partial, last 30 days"
            # Cost is priced from the same scan as the tokens, so both totals carry its date.
            # Live readings carry their epoch; sample notes are written in English.
            observed, since = settings.get("observed"), None
            if "stale" in note:
                if type(observed) in (int, float) and math.isfinite(observed):
                    day = datetime.fromtimestamp(observed)
                    since = f"{day.day} {_MONTHS[day.month - 1]}"
                elif sample := re.search(r"stale as of (\d\d) ([A-Z][a-z]{2})\b", note):
                    since = f"{int(sample.group(1))} {sample.group(2)}"
            name = period + (f", as of {since}" if since else "")
        self._ink_text(ink, (0, baseline(20, 20, 14)), self._fit(draw, name, "sans", 14, width), 14, alpha=INK2)
        figure_x = self._figure_x(draw, figure, label, "medium", 15)
        self._ink_text(ink, (figure_x, baseline(48, 56, 56)), figure, 56, "mono")
        if figure == "—":
            return
        # Facts sit beside a 160 px figure box, or 11 px past a wider figure, as in the design.
        left = max(168, math.ceil(figure_x + self._length(draw, figure, "mono", 56)) + 11)
        for index, (provider, amount, _state) in enumerate(rows):
            shown = "—" if amount == "—" else self._dollars(amount) if cost else amount
            self._fact(ink, draw, (left, baseline(56 + index * 20, 20, 14)), shown, provider, width - left)

    def _ink_span(self, draw: ImageDraw.ImageDraw, text: str, family: str, size: int) -> tuple[int, int]:
        """Left and right ink columns of `text` set from x 0: what the eye centres, not the advance."""
        key = text, family, size, self._frost
        if key not in self._ink_spans:
            scratch = Image.new("L", (math.ceil(self._length(draw, text, family, size)) + 4 * size, 2 * size), 0)
            self._draw_text(ImageDraw.Draw(scratch), (2 * size, size), text, 255, size, family, "ls")
            box = scratch.getbbox()
            if len(self._ink_spans) >= 256:
                self._ink_spans.clear()
            self._ink_spans[key] = (box[0] - 2 * size, box[2] - 2 * size) if box else (0, 0)
        return self._ink_spans[key]

    def _clock_centre(self, draw: ImageDraw.ImageDraw, widgets: list[dict], stats: object) -> float | None:
        """Panel x of the middle of the sheet clock's time ink, or None without a designed clock."""
        clock = next((item for item in widgets if item["type"] == "clock" and "design" in item), None)
        if clock is None:
            return None
        element = next(item for item in resolve_elements({**clock, "settings": rendered_content(clock, stats)})
                       if item["id"] == "time")
        if element["hidden"]:
            return None
        text, family, size = self._safe_text(element["text"]), element["family"], element["size"]
        advance = self._length(draw, text, family, size)
        left, right = self._ink_span(draw, text, family, size)
        if element.get("suffix"):
            right = advance + element["gap"] + self._length(draw, self._safe_text(element["suffix"]), "sans", element["suffixSize"])
            advance = right
        origin = clock["x"] + self._designed_x(draw, element, text) - (0 if element["align"] == "start" else advance / 2 if element["align"] == "center" else advance)
        return origin + (left + right) / 2

    def _sheet_weather(self, ink: Ink, draw: ImageDraw.ImageDraw, width: int, height: int, settings: dict) -> None:
        """Weather on the fog, centred vertically in the widget: a 144 px temperature, a 34 px glyph beside
        the condition (one group), then place and humidity. With a clock the whole block is centred on the
        clock's time ink and clamped to the widget edges; without one it is left-aligned."""
        top = max(0, (height - WEATHER_BLOCK) // 2)
        figure_box = top + WEATHER_FIGURE
        centre = settings.get("clockCentre")

        def across(extent: float, left: float) -> float:
            """Left edge for something `extent` wide: on the clock's centre, kept inside the widget."""
            if centre is None:
                return left
            return min(max(centre - extent / 2, 0), max(0, width - extent))

        figure = f"{settings['temperature']}°"
        ink_left, ink_right = self._ink_span(draw, figure, "mono", WEATHER_FIGURE)
        figure_x = across(ink_right - ink_left, 3 + ink_left) - ink_left
        self._ink_text(ink, (figure_x, baseline(top, WEATHER_FIGURE, WEATHER_FIGURE)), figure, WEATHER_FIGURE, "mono")
        glyph_font = None
        if self._frost:
            key = "icon", 34, True
            if key not in self._fonts:
                try:
                    font = ImageFont.truetype(str(FONT_DIR / ICON_FONT), 34)
                    font.set_variation_by_axes([0, 0, 48, 300])
                    self._fonts[key] = font
                except (OSError, ValueError):
                    self._fonts[key] = None
            glyph_font = self._fonts[key]
        margin = 8 if centre is None else 0
        glyph_width = 46 if glyph_font is not None else 0
        condition = self._fit(draw, settings["condition"], "medium", 28, width - margin - glyph_width)
        group_x = across(glyph_width + self._length(draw, condition, "medium", 28), 8)
        if glyph_font is not None:
            glyph_draw, fill = ink.target(1)
            ascent, descent = glyph_font.getmetrics()
            glyph_draw.text((group_x, figure_box + 2 + (34 - ascent - descent) / 2 + ascent),
                            weather_glyph(settings.get("icon"), settings["condition"]),
                            font=glyph_font, fill=fill, anchor="ls")
        self._ink_text(ink, (group_x + glyph_width, baseline(figure_box, 38, 28)), condition, 28, "medium")
        city = settings.get("city", settings["location"])
        if settings.get("feels") is not None:
            place, humidity = f"{city}, feels like {settings['feels']}°", settings.get("humidity")
            second = None if humidity is None else f"{humidity}% humidity"
        else:
            place, second = city, f"High {settings['high']}°, low {settings['low']}°"
        for index, line in enumerate((place, second)):
            if line:
                line = self._fit(draw, line, "sans", 17, width - margin)
                self._ink_text(ink, (across(self._length(draw, line, "sans", 17), 8), baseline(figure_box + 48 + 26 * index, 26, 17)),
                               line, 17, alpha=INK2)

    def _sheet(self, card: Image.Image, widget: dict, settings: dict, palette: dict) -> bool:
        """Draw a sheet variant; return False for widgets without one."""
        kind, style = widget["type"], settings.get("style")
        if (kind, style) not in (("gauge", "figure"), ("storage", "columns"), ("metric", "rows"), ("metric", "figures"),
                                 ("metric", "total"), ("weather", "block")):
            return False
        ink = Ink(card, palette["text"])
        draw, width, height = ink.direct, widget["width"], widget["height"]
        if kind == "gauge":
            self._sheet_figure(ink, draw, width, settings)
        elif kind == "storage":
            self._sheet_storage(ink, draw, width, settings)
        elif style == "figures":
            self._sheet_limits(ink, draw, width, settings)
        elif style == "total":
            self._sheet_total(ink, draw, width, settings)
        elif kind == "metric":
            self._sheet_threads(ink, draw, width, height, settings)
        else:
            self._sheet_weather(ink, draw, width, height, settings)
        ink.flush()
        return True

    @staticmethod
    def _long_date(raw: str) -> str:
        """Frost's clock date, "samedi 7 novembre", in the runtime's own time locale."""
        now = datetime.now()
        return now.strftime("%A ") + str(now.day) + now.strftime(" %B") if raw != "—" else raw

    def render(self, document: object, stats: object = None, palette: object = None) -> Image.Image:
        """Return RGB pixels in document dimensions, rejecting huge allocations."""
        doc = validate_layout(document)
        width, height = doc["canvas"]["width"], doc["canvas"]["height"]
        if width * height > MAX_RENDER_PIXELS:
            raise ValueError("$.canvas: rendering is limited to 16 million pixels")
        colors = doc["palette"] if palette is None else _palette(palette, "$.renderPalette")
        frost = colors["name"] == FROST
        if frost != self._frost:
            # Wrapped lines were measured in the other face.
            self._wrapped.clear()
            self._frost = frost
        mode = "light" if sum(int(colors["background"][i:i + 2], 16) for i in (1, 3, 5)) > 384 else "dark"
        ground = None
        if frost and doc.get("ground") == "wallpaper" and self.ground is not None:
            try:
                ground = self.ground((width, height), mode)
            except Exception:
                # The fog is decoration: a failure keeps the flat background.
                ground = None
        image = ground.copy() if ground is not None and ground.size == (width, height) else Image.new("RGB", (width, height), colors["background"])
        draw = ImageDraw.Draw(image)
        sources = {widget['settings'].get('source') for widget in doc['widgets']}
        heading = 'AI usage' if any(source and source.startswith(('codex-', 'claude-', 'usage-')) for source in sources) else 'Storage overview' if 'storage' in sources or any(widget['type'] == 'storage' for widget in doc['widgets']) else 'System overview'
        if doc.get('chrome') != 'none':
            self._header(draw, width, stats, colors, not any(widget["type"] == "clock" for widget in doc["widgets"]), heading)
        clock_centre = (self._clock_centre(draw, doc["widgets"], stats)
                        if any(item["type"] == "weather" and item["settings"].get("style") == "block" for item in doc["widgets"])
                        else None)
        for widget in doc["widgets"]:
            w, h = widget["width"], widget["height"]
            card_colors = effective_widget_palette(colors, widget)
            if widget['type'] == 'image':
                settings = widget['settings']
                layer = render_image(settings['data'], w, h, settings['fit'], settings['opacity'])
                overrides = widget.get('colors', {})
                if 'surface' in overrides:
                    background = Image.new('RGBA', (w, h), card_colors['surface'])
                    background.alpha_composite(layer)
                    layer = background
                if 'outline' in overrides:
                    ImageDraw.Draw(layer).rectangle((0, 0, w - 1, h - 1), outline=card_colors['outline'], width=1)
                image.paste(layer, (widget['x'], widget['y']), layer.getchannel('A'))
                continue
            # Frameless widgets draw on what lies beneath them; glass is Frost's slab and a card elsewhere.
            frame = widget.get("frame", "card")
            if frame == "glass" and not frost:
                frame = "card"
            box = (widget["x"], widget["y"], widget["x"] + w, widget["y"] + h)
            if frame == "card":
                # The separate layer clips all glyphs and strokes to this card.
                card = Image.new("RGB", (w, h), card_colors["surface"])
            elif frame == "glass" and min(w, h) > 1:
                card = image.crop(box).convert("RGBA")
                card.alpha_composite(glass_layer(w, h, mode))
                card = card.convert("RGB")
            else:
                card = image.crop(box)
            card_draw = ImageDraw.Draw(card)
            settings = rendered_content(widget, stats)
            if (widget["type"] == "clock" and frost and stats is not None
                    and settings.get("source", "sample") == "clock"):
                settings["date"] = self._long_date(settings["date"])
            if widget["type"] == "weather" and clock_centre is not None:
                settings["clockCentre"] = clock_centre - widget["x"]
            if frame != "card" and min(w, h) == 1:
                # A one-pixel frameless widget is a rule: Frost's hairline, or the outline colour.
                if frost:
                    card.paste(card_colors["text"], (0, 0), Image.new("L", (w, h), round(255 * HAIRLINE)))
                else:
                    card_draw.rectangle((0, 0, w - 1, h - 1), fill=card_colors["outline"])
                image.paste(card, box[:2])
                continue
            if self._sheet(card, widget, settings, card_colors):
                pass
            elif widget["type"] == "metric":
                self._metric(card_draw, w, h, settings, card_colors, stats)
            elif widget["type"] == "weather":
                self._weather(card_draw, w, h, settings, card_colors,
                              stats is not None and settings.get("source", "sample") == "weather")
            elif widget["type"] == "clock":
                if "design" in widget:
                    self._designed_text(card_draw, resolve_elements({**widget, "settings": settings}), card_colors)
                else:
                    self._clock(card_draw, h, settings, card_colors)
            elif widget["type"] == "storage":
                self._storage_card(card_draw, w, h, settings, card_colors)
            elif widget["type"] == "text":
                self._text_card(card_draw, w, h, settings, card_colors)
            elif widget["type"] == "list":
                self._list_card(card_draw, w, h, settings, card_colors)
            elif widget["type"] == "graph":
                self._graph_card(card_draw, w, h, settings, card_colors, stats)
            elif widget["type"] == "calendar":
                self._calendar_card(card_draw, w, h, settings, card_colors)
            elif widget["type"] == "gauge":
                self._gauge(card_draw, w, h, settings, card_colors)
            else:
                raise ValueError(f"{widget['type']} cards have no panel renderer")
            if frame != "card":
                image.paste(card, box[:2])
                continue
            radius = min(18, (w - 1) // 2, (h - 1) // 2)
            bounds = (0, 0, w - 1, h - 1)
            mask = Image.new("L", (w, h), 255 if min(w, h) == 1 else 0)
            if min(w, h) == 1:
                card_draw.rectangle(bounds, fill=card_colors['outline'])
            else:
                card_draw.rounded_rectangle(bounds, radius=radius, outline=card_colors["outline"], width=1)
                ImageDraw.Draw(mask).rounded_rectangle(bounds, radius=radius, fill=255)
            image.paste(card, (widget["x"], widget["y"]), mask)
        # Match the preview's paint order: footer appears above cards.
        if doc.get('chrome') != 'none':
            self._draw_text(draw, (64, height - 69),
                            "Deterministic preview" if stats is None else "Live dashboard",
                            colors["muted"], 13, "mono")
            self._draw_text(draw, (width - 64, height - 69), f"{width} / {height}",
                            colors["muted"], 13, "mono", "rt")
        return image
