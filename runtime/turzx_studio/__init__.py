"""Saved-layout validation, file watching, and CPU rendering for TURZX Studio.

Importing this package does not import the dashboard, collect stats, or open USB.
"""

from .layout import (
    effective_palette,
    parse_caelestia_palette,
    parse_layout,
    revision,
    serialize_layout,
    validate_layout,
)
from .watch import LayoutWatcher

__all__ = [
    "LayoutRenderer",
    "LayoutWatcher",
    "effective_palette",
    "parse_caelestia_palette",
    "parse_layout",
    "revision",
    "rendered_content",
    "serialize_layout",
    "validate_layout",
]


def __getattr__(name: str):
    # Keep contract and watcher imports usable without Pillow.
    if name in ("LayoutRenderer", "rendered_content"):
        from .renderer import LayoutRenderer, rendered_content

        return {"LayoutRenderer": LayoutRenderer, "rendered_content": rendered_content}[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
