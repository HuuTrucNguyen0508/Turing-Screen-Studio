import json
import os
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw

from turzx_studio.frost import FACES, FONT_DIR, PALETTES, ShellStyle, weather_glyph
from turzx_studio.renderer import LayoutRenderer
from turzx_studio.storage import PaletteWatcher

ROOT = Path(__file__).resolve().parents[2]
SCHEME = {"name": "dynamic", "mode": "dark", "colours": {
    "background": "0e0e0e", "surfaceContainer": "1a1a1a", "surfaceContainerHigh": "202020",
    "onSurface": "e5e5e5", "onSurfaceVariant": "ababab", "primary": "c6c6c6",
    "secondary": "9d9d9d", "outlineVariant": "484848"}}
FROST_WALL = "/walls/frost.jpg"


class FrostPaletteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.scheme, self.wallpaper, self.manifest = root / "scheme.json", root / "path.txt", root / "style.json"
        self.write_scheme("dark")
        self.manifest.write_text(json.dumps({"id": "frost", "wallpapers": [FROST_WALL]}))
        self.watcher = PaletteWatcher(self.scheme, ShellStyle(self.wallpaper, self.manifest))

    def tearDown(self):
        self.temp.cleanup()

    def write_scheme(self, mode):
        self.scheme.write_text(json.dumps({**SCHEME, "mode": mode}))

    def set_wallpaper(self, path):
        self.wallpaper.write_text(path + "\n")
        # Same-second rewrites must still invalidate the cached palette.
        stamp = self.wallpaper.stat().st_mtime_ns + 1_000_000_000
        os.utime(self.wallpaper, ns=(stamp, stamp))

    def test_frost_wallpaper_uses_frost_palette_and_follows_mode(self):
        self.set_wallpaper(FROST_WALL)
        self.assertEqual(self.watcher.poll(), PALETTES["dark"])
        self.write_scheme("light")
        stamp = self.scheme.stat().st_mtime_ns + 1_000_000_000
        os.utime(self.scheme, ns=(stamp, stamp))
        self.assertEqual(self.watcher.poll()["background"], "#f8f8f8")

    def test_other_styles_keep_following_caelestia(self):
        self.set_wallpaper("/walls/folio.jpg")
        self.assertEqual(self.watcher.poll()["surface"], "#1a1a1a")
        self.set_wallpaper(FROST_WALL)
        self.assertEqual(self.watcher.poll()["surface"], "#1a1b1e")
        self.set_wallpaper("/walls/folio.jpg")
        self.assertEqual(self.watcher.poll()["name"], "dynamic")

    def test_unreadable_style_files_fall_back_to_caelestia(self):
        self.assertEqual(self.watcher.poll()["name"], "dynamic")
        self.set_wallpaper(FROST_WALL)
        self.manifest.write_text("{not json")
        self.assertEqual(self.watcher.poll()["name"], "dynamic")
        self.assertIsNone(self.watcher.error)

    def test_watcher_without_style_ignores_the_shell(self):
        self.set_wallpaper(FROST_WALL)
        self.assertEqual(PaletteWatcher(self.scheme).poll()["name"], "dynamic")


class WeatherGlyphTests(unittest.TestCase):
    def test_provider_codes_win_over_condition_text(self):
        self.assertEqual(weather_glyph("03n", "Scattered Clouds"), "cloud")
        self.assertEqual(weather_glyph("02d", "whatever"), "partly_cloudy_day")
        self.assertEqual(weather_glyph("10d", ""), "rainy")

    def test_condition_text_maps_sample_data(self):
        self.assertEqual(weather_glyph(None, "Partly cloudy"), "partly_cloudy_day")
        self.assertEqual(weather_glyph("", "Light rain"), "rainy")
        self.assertEqual(weather_glyph(None, "—"), "cloud")


@unittest.skipUnless(all((FONT_DIR / face).is_file() for face in FACES.values()), "Fira Sans is not installed")
class FrostRenderTests(unittest.TestCase):
    def setUp(self):
        self.doc = json.loads((ROOT / "public/sample-layout.json").read_text())
        self.renderer = LayoutRenderer()

    def test_figures_keep_their_width_while_separators_stay_narrow(self):
        self.renderer.render(self.doc, palette=PALETTES["dark"])
        draw = ImageDraw.Draw(Image.new("RGB", (1, 1)))
        length = lambda text: self.renderer._length(draw, text, "mono", 72)
        self.assertEqual(length("11:11"), length("20:48"))
        self.assertEqual(length("1.1"), length("8.8"))
        # A tabular colon would be as wide as a digit.
        self.assertLess(length(":"), length("0") * .6)

    def test_frost_face_applies_only_to_the_frost_palette(self):
        frost = self.renderer.render(self.doc, palette=PALETTES["dark"])
        renamed = self.renderer.render(self.doc, palette={**PALETTES["dark"], "name": "dynamic"})
        self.assertNotEqual(frost.tobytes(), renamed.tobytes())
        self.assertEqual(renamed.tobytes(), LayoutRenderer().render(self.doc, palette={**PALETTES["dark"], "name": "dynamic"}).tobytes())


if __name__ == "__main__":
    unittest.main()
