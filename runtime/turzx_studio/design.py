"""Clock presentation validation and placement, without Pillow or layout imports."""

from __future__ import annotations

import math
import re

DESIGN_ALIGNS = ("start", "center", "end")
DESIGN_COLORS = ("text", "muted", "primary", "secondary")
ELEMENT_PROPS = ("hidden", "align", "dx", "dy", "size", "color")
ELEMENT_SPECS = {"clock": (
    {"id": "label", "name": "Label", "props": ELEMENT_PROPS},
    {"id": "time", "name": "Time", "props": ELEMENT_PROPS},
    {"id": "date", "name": "Date", "props": ELEMENT_PROPS},
)}


def _fail(path: str, message: str) -> None:
    raise ValueError(f"{path}: {message}")


def _object(value: object, path: str) -> dict:
    if type(value) is not dict:
        _fail(path, "expected a plain JSON object")
    if not value:
        _fail(path, "remove the empty object")
    return value


def _keys(value: dict, allowed: tuple, path: str,
          message: str = "unexpected field") -> None:
    for key in value:
        if key not in allowed:
            _fail(f"{path}.{key}", message)


def _integer(value: object, path: str, minimum: int, maximum: int) -> int:
    if type(value) not in (int, float):
        _fail(path, "expected a safe integer")
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        _fail(path, "expected a safe integer")
    if abs(value) > 2**53 - 1:
        _fail(path, "expected a safe integer")
    if not minimum <= value <= maximum:
        _fail(path, f"must be between {minimum} and {maximum}")
    return int(value)


def validate_widget_design(input: object, kind: str, path: str) -> dict:
    """Return detached presentation values in the editor's canonical order."""
    if kind not in ELEMENT_SPECS:
        _fail(path, f"{kind} cards have no editable elements")
    value = _object(input, path)
    _keys(value, ("padding", "elements"), path)
    result = {}
    if "padding" in value:
        result["padding"] = _integer(value["padding"], f"{path}.padding", 0, 64)
    if "elements" in value:
        elements_path = f"{path}.elements"
        elements = _object(value["elements"], elements_path)
        ids = tuple(spec["id"] for spec in ELEMENT_SPECS[kind])
        _keys(elements, ids, elements_path,
              f"unknown {kind} element; expected {', '.join(ids)}")
        result["elements"] = {}
        for spec in ELEMENT_SPECS[kind]:
            element_id = spec["id"]
            if element_id not in elements:
                continue
            element_path = f"{elements_path}.{element_id}"
            raw = _object(elements[element_id], element_path)
            _keys(raw, spec["props"], element_path,
                  f"{element_id} supports {', '.join(spec['props'])}")
            element = {}
            for prop in ELEMENT_PROPS:
                if prop not in raw:
                    continue
                field_path = f"{element_path}.{prop}"
                if prop == "hidden":
                    if type(raw[prop]) is not bool:
                        _fail(field_path, "expected a boolean")
                    element[prop] = raw[prop]
                elif prop in ("align", "color"):
                    choices = DESIGN_ALIGNS if prop == "align" else DESIGN_COLORS
                    if raw[prop] not in choices:
                        _fail(field_path, f"expected {', '.join(choices)}")
                    element[prop] = raw[prop]
                else:
                    element[prop] = _integer(raw[prop], field_path,
                                             8 if prop == "size" else -512,
                                             160 if prop == "size" else 512)
            result["elements"][element_id] = element
    return result


def clock_time(value: str, format: str) -> str:
    """Match the editor's minute precision and conversion of saved samples."""
    match = re.search(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", value)
    if not match:
        return value
    hour, minute = int(match[1]), match[2]
    if re.search(r"\bPM\b", value, re.IGNORECASE) and hour < 12:
        hour += 12
    elif re.search(r"\bAM\b", value, re.IGNORECASE) and hour == 12:
        hour = 0
    return (f"{hour:02d}:{minute}" if format == "24h" else
            f"{hour % 12 or 12}:{minute} {'PM' if hour >= 12 else 'AM'}")


def element_specs(widget: dict) -> tuple:
    return ELEMENT_SPECS.get(widget["type"], ())


def resolve_elements(widget: dict) -> list[dict]:
    """Resolve alphabetic baselines and whole-chunk horizontal anchors."""
    if widget["type"] != "clock":
        return []
    settings = widget["settings"]
    width, height = widget["width"], widget["height"]
    compact = height < 184
    design = widget.get("design", {})
    padding = design.get("padding", 29)
    parts = clock_time(settings["time"], settings["format"]).split(" ", 1)
    defaults = (
        {"y": 22 if compact else 39, "size": 13 if compact else 15,
         "color": "muted", "family": "sans", "text": settings["label"],
         "hidden": compact or not settings["label"]},
        {"y": height // 2 + (-1 if settings["showDate"] else 10) if compact else 110,
         "size": 40 if compact else 72, "color": "text" if compact else "primary",
         "family": "mono", "text": parts[0], "hidden": False,
         **({"suffix": parts[1], "suffixSize": 16 if compact else 23,
             "gap": 6 if compact else 9} if len(parts) > 1 else {})},
        {"y": height // 2 + 26 if compact else height - 29,
         "size": 14 if compact else 15, "color": "muted", "family": "sans",
         "text": settings["date"], "hidden": not settings["showDate"]},
    )
    result = []
    for spec, default in zip(ELEMENT_SPECS["clock"], defaults):
        element = design.get("elements", {}).get(spec["id"], {})
        align = element.get("align", "start")
        size = element.get("size", default["size"])
        resolved = {**default, "id": spec["id"], "name": spec["name"],
                    "align": align, "size": size,
                    "x": (width / 2 if align == "center" else
                          width - padding if align == "end" else padding) + element.get("dx", 0),
                    "y": default["y"] + element.get("dy", 0),
                    "color": element.get("color", default["color"]),
                    "hidden": ((spec["id"] == "date" and not settings["showDate"])
                               or element.get("hidden", default["hidden"]))}
        if "suffix" in default:
            # Python round ties to even; the editor's Math.round ties upward.
            resolved["suffixSize"] = math.floor(size * (.4 if compact else 23 / 72) + .5)
        result.append(resolved)
    return result


def update_widget_design(doc: dict, widget_id: str, patch: dict) -> dict:
    """Apply an override or reset, pruning empty objects and preserving no-ops."""
    index = next((i for i, widget in enumerate(doc["widgets"])
                  if widget["id"] == widget_id), None)
    if index is None:
        _fail("$.widgets", f'widget ID "{widget_id}" was not found')
    widget = doc["widgets"][index]
    path = f"$.widgets[{index}].design"
    if widget["type"] not in ELEMENT_SPECS:
        _fail(path, f'{widget["type"]} cards have no editable elements')
    design = dict(widget.get("design", {}))
    if "elements" in design:
        design["elements"] = dict(design["elements"])
    if "element" in patch:
        element_id = patch["element"]
        ids = tuple(spec["id"] for spec in ELEMENT_SPECS[widget["type"]])
        if element_id not in ids:
            _fail(f"{path}.elements.{element_id}", "unknown clock element; expected label, time, date")
        elements = design.get("elements", {})
        if patch.get("reset"):
            elements.pop(element_id, None)
        else:
            element = {**elements.get(element_id, {}), **patch["set"]}
            if element:
                elements[element_id] = element
        if elements:
            design["elements"] = elements
        else:
            design.pop("elements", None)
    elif "padding" in patch:
        if patch["padding"] is None:
            design.pop("padding", None)
        else:
            design["padding"] = patch["padding"]
    elif patch.get("reset"):
        design = {}
    design = validate_widget_design(design, widget["type"], path) if design else None
    if design == widget.get("design"):
        return doc
    replacement = {key: value for key, value in widget.items() if key != "design"}
    if design is not None:
        replacement["design"] = design
    widgets = doc["widgets"][:]
    widgets[index] = replacement
    return {**doc, "widgets": widgets}
