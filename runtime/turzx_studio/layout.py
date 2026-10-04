"""The version 1 layout contract, independent of Pillow and the dashboard."""

from __future__ import annotations

import hashlib
import json
import math
import re

MAX_CANVAS_SIZE = 16384
MAX_SAFE_INTEGER = 2**53 - 1
PALETTE_ROLES = (
    "background", "surface", "surfaceRaised", "text", "muted", "primary",
    "secondary", "outline",
)
METRIC_SETTINGS = ("label", "value", "unit", "detail")
WEATHER_SETTINGS = ("location", "temperature", "unit", "condition", "high", "low")
METRIC_SOURCES = (
    "sample", "cpu", "gpu", "memory", "disk", "network-down", "network-up",
)
_HEX = re.compile(r"#[0-9a-fA-F]{6}\Z")


def _fail(path: str, message: str) -> None:
    raise ValueError(f"{path}: {message}")


def _object(value: object, path: str) -> dict:
    if type(value) is not dict:
        _fail(path, "expected a plain JSON object")
    return value


def _keys(value: dict, required: tuple[str, ...], path: str,
          optional: tuple[str, ...] = ()) -> None:
    for key in value:
        if key not in required and key not in optional:
            _fail(f"{path}.{key}", "unexpected field")
    for key in required:
        if key not in value:
            _fail(f"{path}.{key}", "required field is missing")


def _string(value: object, path: str, nonempty: bool = False) -> str:
    if not isinstance(value, str):
        _fail(path, "expected a string")
    if nonempty and not value.strip():
        _fail(path, "must not be empty")
    return value


def _integer(value: object, path: str, minimum: int,
             maximum: int = MAX_SAFE_INTEGER) -> int:
    if type(value) not in (int, float):
        _fail(path, "expected a safe integer")
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        _fail(path, "expected a safe integer")
    if abs(value) > MAX_SAFE_INTEGER:
        _fail(path, "expected a safe integer")
    if not minimum <= value <= maximum:
        _fail(path, f"must be between {minimum} and {maximum}")
    # JSON has one number type. Match Number.isSafeInteger in the editor.
    return int(value)


def _color(value: object, path: str) -> str:
    color = _string(value, path)
    if not _HEX.fullmatch(color):
        _fail(path, "expected a six-digit #hex color")
    return color


def _palette(value: object, path: str) -> dict:
    value = _object(value, path)
    _keys(value, ("name", *PALETTE_ROLES), path)
    return {
        "name": _string(value["name"], f"{path}.name"),
        **{role: _color(value[role], f"{path}.{role}") for role in PALETTE_ROLES},
    }


def _widget(value: object, path: str, canvas: dict) -> dict:
    value = _object(value, path)
    _keys(value, ("id", "type", "x", "y", "width", "height", "settings"), path)
    widget_id = _string(value["id"], f"{path}.id", nonempty=True)
    kind = value["type"]
    if kind not in ("metric", "weather"):
        _fail(f"{path}.type", 'unsupported widget type; expected "metric" or "weather"')
    geometry = {
        key: _integer(value[key], f"{path}.{key}", 0 if key in ("x", "y") else 1)
        for key in ("x", "y", "width", "height")
    }
    if geometry["x"] > canvas["width"] - geometry["width"]:
        _fail(f"{path}.width", "x + width must fit inside canvas.width")
    if geometry["y"] > canvas["height"] - geometry["height"]:
        _fail(f"{path}.height", "y + height must fit inside canvas.height")
    settings_path = f"{path}.settings"
    settings = _object(value["settings"], settings_path)
    fields = METRIC_SETTINGS if kind == "metric" else WEATHER_SETTINGS
    _keys(settings, fields, settings_path, ("source",))
    result = {key: _string(settings[key], f"{settings_path}.{key}") for key in fields}
    if "source" in settings:
        source = _string(settings["source"], f"{settings_path}.source")
        sources = METRIC_SOURCES if kind == "metric" else ("sample", "weather")
        if source not in sources:
            _fail(f"{settings_path}.source", f"expected one of {', '.join(sources)}")
        result["source"] = source
    return {"id": widget_id, "type": kind, **geometry, "settings": result}


def validate_layout(input: object, panel: bool = False) -> dict:
    """Return a detached, canonically ordered document; reject unknown fields.

    ``panel=True`` also requires the landscape panel's 1280 by 800 canvas.
    Optional source and paletteMode fields retain their presence or absence.
    """
    value = _object(input, "$")
    if "version" not in value:
        _fail("$.version", "required field is missing; choose a TURZX layout JSON file")
    if type(value["version"]) not in (int, float) or value["version"] != 1:
        _fail("$.version", "unsupported layout version; expected 1")
    _keys(value, ("version", "name", "canvas", "palette", "widgets"), "$", ("paletteMode",))
    name = _string(value["name"], "$.name", nonempty=True)
    canvas_value = _object(value["canvas"], "$.canvas")
    _keys(canvas_value, ("width", "height"), "$.canvas")
    canvas = {
        key: _integer(canvas_value[key], f"$.canvas.{key}", 1, MAX_CANVAS_SIZE)
        for key in ("width", "height")
    }
    if panel and (canvas["width"], canvas["height"]) != (1280, 800):
        _fail("$.canvas", "panel layouts must be 1280 by 800 pixels")
    palette = _palette(value["palette"], "$.palette")
    if type(value["widgets"]) is not list:
        _fail("$.widgets", "expected an array")
    widgets = []
    ids = set()
    for index, raw in enumerate(value["widgets"]):
        widget = _widget(raw, f"$.widgets[{index}]", canvas)
        if widget["id"] in ids:
            _fail(f"$.widgets[{index}].id", f'duplicate widget ID "{widget["id"]}"')
        ids.add(widget["id"])
        widgets.append(widget)
    result = {"version": 1, "name": name, "canvas": canvas, "palette": palette, "widgets": widgets}
    if "paletteMode" in value:
        mode = value["paletteMode"]
        if mode not in ("saved", "live"):
            _fail("$.paletteMode", 'expected "saved" or "live"')
        result["paletteMode"] = mode
    return result


class _Pairs(list):
    """Preserve object pairs until their field paths can be checked."""


def _json(text: str) -> object:
    def constant(value: str) -> None:
        _fail("$", f"invalid JSON number {value}; use finite numbers")

    def decimal(value: str) -> float:
        number = float(value)
        if not math.isfinite(number):
            _fail("$", f"invalid JSON number {value}; use finite numbers")
        return number

    def unpack(value: object, path: str) -> object:
        if isinstance(value, _Pairs):
            result = {}
            for key, item in value:
                if key in result:
                    _fail(f"{path}.{key}", "duplicate JSON object key")
                result[key] = unpack(item, f"{path}.{key}")
            return result
        if isinstance(value, list):
            return [unpack(item, f"{path}[{i}]") for i, item in enumerate(value)]
        return value

    if not isinstance(text, str):
        _fail("$", "expected JSON text")
    try:
        return unpack(json.loads(text, object_pairs_hook=_Pairs,
                                 parse_constant=constant, parse_float=decimal), "$")
    except json.JSONDecodeError as error:
        _fail("$", f"invalid JSON at line {error.lineno}, column {error.colno}: {error.msg}")
    except RecursionError:
        _fail("$", "JSON nesting is too deep")


def parse_layout(text: str, panel: bool = False) -> dict:
    """Parse strict JSON, rejecting duplicate keys and nonfinite numbers."""
    return validate_layout(_json(text), panel=panel)


def serialize_layout(doc: object) -> str:
    """Match the editor's two-space UTF-8 JSON format with one final newline."""
    text = json.dumps(validate_layout(doc), ensure_ascii=False, indent=2, allow_nan=False)
    # JSON.stringify escapes lone UTF-16 surrogates but preserves valid pairs.
    def surrogate(match: re.Match) -> str:
        value = match.group()
        if len(value) == 2:
            return chr(0x10000 + (ord(value[0]) - 0xD800) * 0x400 + ord(value[1]) - 0xDC00)
        return f"\\u{ord(value):04x}"

    return re.sub(r"[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]", surrogate, text) + "\n"


def revision(doc: object) -> str:
    """SHA-256 of canonical serialized UTF-8 JSON, including the final newline."""
    return hashlib.sha256(serialize_layout(doc).encode("utf-8")).hexdigest()


def parse_caelestia_palette(text: str) -> dict:
    """Map a Caelestia colours/colors object, or an existing role palette.

    The result has a name and exactly eight color roles. Scheme metadata and
    unused Caelestia colors are allowed; all eight mapped colors are required.
    """
    value = _object(_json(text), "$")
    if "colours" in value or "colors" in value:
        container = "colours" if "colours" in value else "colors"
        colors = _object(value[container], f"$.{container}")
        mappings = dict(zip(PALETTE_ROLES, (
            "background", "surfaceContainer", "surfaceContainerHigh", "onSurface",
            "onSurfaceVariant", "primary", "secondary", "outlineVariant",
        )))
        path = f"$.{container}"
    else:
        colors = value
        mappings = {role: role for role in PALETTE_ROLES}
        path = "$"
    name = _string(value.get("name", "Caelestia"), "$.name", nonempty=True)
    result = {"name": name}
    for role, key in mappings.items():
        if key not in colors:
            _fail(f"{path}.{key}", "required color is missing")
        raw = _string(colors[key], f"{path}.{key}")
        result[role] = _color(raw if raw.startswith("#") else f"#{raw}", f"{path}.{key}").lower()
    return result


def effective_palette(doc: object, live_palette: object = None) -> dict:
    """Return detached live roles only when opted in and a live palette exists."""
    document = validate_layout(doc)
    if document.get("paletteMode", "saved") == "live" and live_palette is not None:
        return _palette(live_palette, "$.livePalette")
    return document["palette"]
