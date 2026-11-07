import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from PIL import Image

from turzx_studio.frost import PALETTES
from turzx_studio.ground import WallpaperGround, make_ground
from turzx_studio.layout import parse_layout, serialize_layout, validate_layout
from turzx_studio.renderer import LayoutRenderer
from turzx_studio.dashboard_display import DashboardStats
from server import sheet_features

ROOT = Path(__file__).resolve().parents[2]
SHEET = json.loads((ROOT / "layouts/frost-sheet.json").read_text())
SAMPLE = json.loads((ROOT / "public/sample-layout.json").read_text())
FOG = (70, 70, 72)


def fog(size, mode):
    return Image.new("RGB", size, FOG)


def widget(doc, identifier):
    return next(item for item in doc["widgets"] if item["id"] == identifier)


class SheetContractTests(unittest.TestCase):
    def test_sheet_layout_is_canonical_and_round_trips(self):
        doc = parse_layout((ROOT / "layouts/frost-sheet.json").read_text(), panel=True)
        self.assertEqual(serialize_layout(doc), (ROOT / "layouts/frost-sheet.json").read_text())
        self.assertEqual(doc["ground"], "wallpaper")
        self.assertEqual(widget(doc, "sheet")["frame"], "glass")
        self.assertTrue(sheet_features(doc))
        self.assertFalse(sheet_features(validate_layout(SAMPLE)))

    def test_rejects_unknown_frames_grounds_and_styles(self):
        cases = [
            (lambda d: d.update(ground="fog"), "$.ground: expected flat, wallpaper"),
            (lambda d: widget(d, "sheet").update(frame="box"), ".frame: expected card, none, glass"),
            (lambda d: widget(d, "weather")["settings"].update(style="wide"), ".settings.style: expected block"),
            (lambda d: widget(d, "t3-threads")["settings"].update(source="cpu"), "rows require the t3-threads source"),
            (lambda d: widget(d, "mounted-storage")["settings"].update(style="grid"), "expected bars, table, columns"),
            (lambda d: widget(d, "clock")["design"]["elements"]["time"].update(size=201), "between 8 and 200"),
        ]
        for change, message in cases:
            with self.subTest(message=message):
                doc = copy.deepcopy(SHEET)
                change(doc)
                with self.assertRaisesRegex(ValueError, message.replace("$", r"\$").replace(".", r"\.")):
                    validate_layout(doc)


class GroundTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.wall = self.root / "wall.png"
        Image.new("RGB", (1600, 1000), (200, 200, 200)).save(self.wall)
        self.state = self.root / "path.txt"
        self.state.write_text(f"{self.wall}\n")

    def tearDown(self):
        self.temp.cleanup()

    def test_dark_ground_is_toned_smoke_and_cached_on_disk(self):
        ground = WallpaperGround(self.state, self.root / "cache")
        image = ground((1280, 800), "dark")
        # 200 * 0.40 + 6, with the blue lean of +2.
        self.assertEqual(image.getpixel((640, 400)), (86, 86, 88))
        self.assertEqual(len(list((self.root / "cache").glob("*.png"))), 1)
        self.assertIs(ground((1280, 800), "dark"), image)
        fresh = WallpaperGround(self.state, self.root / "cache")((1280, 800), "dark")
        self.assertEqual(fresh.tobytes(), image.tobytes())
        self.assertEqual(make_ground(self.wall, (1280, 800), "light").getpixel((0, 0)), (225, 225, 225))

    def test_missing_wallpaper_falls_back_to_the_flat_background(self):
        self.state.write_text(str(self.root / "missing.jpg"))
        ground = WallpaperGround(self.state, self.root / "cache")
        self.assertIsNone(ground((1280, 800), "dark"))
        image = LayoutRenderer(ground=ground).render(SHEET)
        self.assertEqual(image.getpixel((5, 5)), (0x14, 0x15, 0x18))


class SheetRenderTests(unittest.TestCase):
    def setUp(self):
        self.renderer = LayoutRenderer(ground=fog)

    def test_frost_paints_fog_glass_rim_and_hairlines(self):
        image = self.renderer.render(SHEET)
        self.assertEqual(image.getpixel((300, 760)), FOG)
        inside = image.getpixel((900, 650))
        self.assertTrue(all(25 <= channel <= 40 for channel in inside), inside)
        # The rim is the brightest line of the slab; the edge is fainter.
        rim, below = image.getpixel((888, 64)), image.getpixel((888, 66))
        self.assertGreater(rim[0], below[0] + 50)
        rule = widget(SHEET, "rule-1")
        line, beside = image.getpixel((700, rule["y"])), image.getpixel((700, rule["y"] + 3))
        self.assertGreater(line[0], beside[0] + 20)

    def test_figure_meter_follows_the_live_reading(self):
        stats = SimpleNamespace(cpu_percent=50, cpu_temp=70, cpu_freq_mhz=5000, cpu_name="Ryzen", clock="sam. 07 nov.  23:46")
        image = self.renderer.render(SHEET, stats=stats)
        cpu = widget(SHEET, "cpu")
        meter_y = cpu["y"] + 161
        lit = [x for x in range(cpu["x"], cpu["x"] + cpu["width"]) if image.getpixel((x, meter_y))[0] > 200]
        self.assertEqual((min(lit), max(lit)), (cpu["x"], cpu["x"] + 91))

    def test_thread_rows_fill_capacity_then_count_the_rest(self):
        threads = [{"id": str(i), "title": f"Thread {i}", "provider": "claudeAgent", "status": "running"} for i in range(6)]
        activity = {"status": "live", "working": 6, "threads": threads, "observedAt": "2026-11-07T23:00:00Z", "note": "Verified T3 execution."}
        drawn = []
        original = self.renderer._ink_text

        def spy(ink, xy, text, *args, **kwargs):
            drawn.append(text)
            return original(ink, xy, text, *args, **kwargs)

        self.renderer._ink_text = spy
        self.renderer.render(SHEET, stats=DashboardStats(SimpleNamespace(), activity, None))
        self.assertEqual([text for text in drawn if text.startswith("Thread ")], [f"Thread {i}" for i in range(4)])
        self.assertIn("2 more in T3", drawn)
        self.assertIn("6 working", drawn)

    def test_other_palettes_render_sheet_fields_as_before(self):
        plain = validate_layout(SAMPLE)
        dressed = copy.deepcopy(plain)
        dressed["ground"] = "wallpaper"
        for item in dressed["widgets"]:
            item["frame"] = "glass"
        self.assertEqual(self.renderer.render(dressed).tobytes(), LayoutRenderer().render(plain).tobytes())

    def test_frost_without_sheet_fields_ignores_the_ground_provider(self):
        doc = {**validate_layout(SAMPLE), "palette": PALETTES["dark"]}
        self.assertEqual(self.renderer.render(doc).tobytes(), LayoutRenderer().render(doc).tobytes())


if __name__ == "__main__":
    unittest.main()
