"""The shell's Frost style: its palette, faces and weather glyphs for the panel.

The Caelestia shell picks a style by wallpaper: Frost is active while its
style.json lists the current wallpaper. Frost has no colour accent, so its
palette replaces the neutral Caelestia scheme instead of mapping from it.
"""
from __future__ import annotations

import json
from pathlib import Path

FROST = "frost"

# Tokens.qml: dark ground is Tokens.inverse, ink2/ink3 are snow at 0.86/0.74 over it,
# the hairline is snow at 0.14 over the smoke surface.
PALETTES = {
    "dark": {"name": FROST, "background": "#141518", "surface": "#1a1b1e",
             "surfaceRaised": "#252629", "text": "#f4f4f3", "muted": "#bababa",
             "primary": "#f4f4f3", "secondary": "#d5d5d4", "outline": "#39393c"},
    "light": {"name": FROST, "background": "#f8f8f8", "surface": "#ffffff",
              "surfaceRaised": "#f1f1f1", "text": "#1c1e21", "muted": "#40444a",
              "primary": "#1c1e21", "secondary": "#33363b", "outline": "#dedede"},
}

FONT_DIR = Path("/usr/share/fonts/TTF")
FACES = {"regular": "FiraSans-Regular.ttf", "medium": "FiraSans-Medium.ttf",
         "light": "FiraSans-Light.ttf", "thin": "FiraSans-ExtraLight.ttf"}
ICON_FONT = "MaterialSymbolsRounded[FILL,GRAD,opsz,wght].ttf"
# FrostIcon's outline axes, light weight to sit beside the thin figures: FILL, GRAD, opsz, wght
ICON_AXES = (0, 0, 48, 200)
# Figures at or above this size take the thin face, like the shell's large numbers;
# words and units beside them take the light face so they don't outweigh the figures
THIN_FROM = 40
LIGHT_FROM = 28

# OpenWeatherMap icon codes to the glyphs Icons.qml uses for the same conditions
_OWM_GLYPHS = {"01": "clear_day", "02": "partly_cloudy_day", "03": "cloud", "04": "cloud",
               "09": "rainy", "10": "rainy", "11": "thunderstorm", "13": "cloudy_snowing",
               "50": "foggy"}
_WORD_GLYPHS = (("thunder", "thunderstorm"), ("snow", "cloudy_snowing"), ("sleet", "cloudy_snowing"),
                ("rain", "rainy"), ("drizzle", "rainy"), ("shower", "rainy"), ("fog", "foggy"),
                ("mist", "foggy"), ("haze", "foggy"), ("partly", "partly_cloudy_day"),
                ("few clouds", "partly_cloudy_day"), ("cloud", "cloud"), ("overcast", "cloud"),
                ("clear", "clear_day"), ("sun", "clear_day"))


def weather_glyph(icon: object, condition: str) -> str:
    """Prefer the provider's icon code; sample data only has its condition text."""
    if isinstance(icon, str) and icon[:2] in _OWM_GLYPHS:
        return _OWM_GLYPHS[icon[:2]]
    text = condition.lower()
    return next((glyph for word, glyph in _WORD_GLYPHS if word in text), "cloud")


class ShellStyle:
    """Report whether the shell's current wallpaper belongs to one style (Frost by default)."""

    def __init__(self, wallpaper: Path | None = None, manifest: Path | None = None, style: str = FROST) -> None:
        home = Path.home()
        self.wallpaper = wallpaper or home / ".local/state/caelestia/wallpaper/path.txt"
        self.manifest = manifest or home / f".config/quickshell/caelestia/modules/styles/{style}/style.json"

    def signature(self) -> tuple:
        result = []
        for path in (self.wallpaper, self.manifest):
            try:
                info = path.stat()
                result.append((str(path.resolve()), info.st_ino, info.st_mtime_ns, info.st_size))
            except OSError:
                result.append(None)
        return tuple(result)

    def active(self) -> bool:
        # Any read failure means another style is showing: keep following Caelestia.
        try:
            current = self.wallpaper.read_text(encoding="utf-8").strip()
            claimed = json.loads(self.manifest.read_text(encoding="utf-8")).get("wallpapers", [])
        except (OSError, ValueError, AttributeError):
            return False
        return bool(current) and isinstance(claimed, list) and current in claimed


def scheme_mode(scheme_text: str) -> str:
    """The scheme's mode: "light", or "dark" for anything else."""
    try:
        mode = json.loads(scheme_text).get("mode")
    except (ValueError, AttributeError):
        mode = None
    return "light" if mode == "light" else "dark"


def frost_palette(scheme_text: str) -> dict:
    return dict(PALETTES[scheme_mode(scheme_text)])
