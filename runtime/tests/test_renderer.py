"""Pixel and live-binding tests without collectors, USB, or external assets."""

from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import ImageChops, ImageDraw

from turzx_studio.layout import parse_layout
from turzx_studio.renderer import LayoutRenderer, rendered_content

SAMPLE_PATH = Path(__file__).resolve().parents[2] / "public" / "sample-layout.json"


def rgb(value):
    return tuple(int(value[index:index + 2], 16) for index in (1, 3, 5))


class RendererTests(unittest.TestCase):
    def setUp(self):
        self.doc = parse_layout(SAMPLE_PATH.read_text(encoding="utf-8"))
        self.renderer = LayoutRenderer()
        self.stats = SimpleNamespace(
            cpu_percent=24.2, cpu_temp=42.2, cpu_freq_mhz=3600.2,
            gpu_percent=18.2, gpu_temp=55.1, gpu_vram_used_mb=6348.8, gpu_vram_total_mb=16384,
            ram_percent=38.7, ram_used_gb=12.44, ram_total_gb=32,
            disk_percent=61.2, disk_used_gb=122.36, disk_total_gb=200,
            net_down_kbps=2048, net_up_kbps=512, wifi_iface="wlan0",
            weather_city="Paris", weather_country="FR", weather_temp_c=19.2,
            weather_description="Partly cloudy", clock="Sun 04 Oct  13:27",
            cpu_history=[1, 2, 3],
        )

    def test_sample_is_rgb_deterministic_and_inputs_are_unchanged(self):
        original = deepcopy(self.doc)
        first = self.renderer.render(self.doc)
        second = self.renderer.render(self.doc)
        self.assertEqual(first.mode, "RGB")
        self.assertEqual(first.size, (1280, 800))
        self.assertEqual(first.tobytes(), second.tobytes())
        self.assertEqual(self.doc, original)
        self.assertEqual(first.getpixel((20, 400)), rgb(self.doc["palette"]["background"]))
        self.assertEqual(first.getpixel((900, 680)), rgb(self.doc["palette"]["background"]))
        cpu = self.doc["widgets"][0]
        self.assertEqual(first.getpixel((cpu["x"] + 8, cpu["y"] + 100)),
                         rgb(self.doc["palette"]["surface"]))

    def test_movement_translates_matching_card_pixels_and_nothing_else(self):
        document = deepcopy(self.doc)
        document["widgets"] = [document["widgets"][0]]
        widget = document["widgets"][0]
        widget.update(x=100, y=180, width=352, height=224)
        first = self.renderer.render(document)
        moved = deepcopy(document)
        moved["widgets"][0].update(x=600, y=420)
        second = self.renderer.render(moved)
        old_bounds = (100, 180, 452, 404)
        new_bounds = (600, 420, 952, 644)
        self.assertEqual(first.crop(old_bounds).tobytes(), second.crop(new_bounds).tobytes())
        differences = ImageChops.difference(first, second)
        self.assertIsNotNone(differences.getbbox())
        draw = ImageDraw.Draw(differences)
        for left, top, right, bottom in (old_bounds, new_bounds):
            draw.rectangle((left, top, right - 1, bottom - 1), fill=(0, 0, 0))
        self.assertIsNone(differences.getbbox())

    def test_one_pixel_and_tiny_cards_clip_all_content_to_geometry(self):
        empty = deepcopy(self.doc)
        empty["widgets"] = []
        background = self.renderer.render(empty)
        for kind in ("metric", "weather"):
            source_widget = next(widget for widget in self.doc["widgets"] if widget["type"] == kind)
            for width, height in ((1, 1), (1, 17), (17, 1), (8, 8), (20, 70)):
                document = deepcopy(empty)
                widget = deepcopy(source_widget)
                widget.update(x=10, y=200, width=width, height=height)
                document["widgets"] = [widget]
                with self.subTest(kind=kind, width=width, height=height):
                    actual = self.renderer.render(document)
                    changed = ImageChops.difference(background, actual).getbbox()
                    self.assertIsNotNone(changed)
                    self.assertGreaterEqual(changed[0], 10)
                    self.assertGreaterEqual(changed[1], 200)
                    self.assertLessEqual(changed[2], 10 + width)
                    self.assertLessEqual(changed[3], 200 + height)
                    if (width, height) == (1, 1):
                        self.assertEqual(actual.getpixel((10, 200)), rgb(document["palette"]["outline"]))

    def test_resize_changes_card_bounds_and_leaves_neighbors_unchanged(self):
        first = self.renderer.render(self.doc)
        changed = deepcopy(self.doc)
        changed["widgets"][0]["width"] -= 20
        second = self.renderer.render(changed)
        gpu = self.doc["widgets"][1]
        bounds = (gpu["x"], gpu["y"], gpu["x"] + gpu["width"], gpu["y"] + gpu["height"])
        self.assertEqual(first.crop(bounds).tobytes(), second.crop(bounds).tobytes())
        difference = ImageChops.difference(first, second).getbbox()
        cpu = self.doc["widgets"][0]
        self.assertIsNotNone(difference)
        self.assertGreaterEqual(difference[0], cpu["x"])
        self.assertGreaterEqual(difference[1], cpu["y"])
        self.assertLessEqual(difference[2], cpu["x"] + cpu["width"])
        self.assertLessEqual(difference[3], cpu["y"] + cpu["height"])

    def test_supplied_palette_is_used_even_for_saved_mode(self):
        palette = {**self.doc["palette"], "name": "override", "background": "#123456", "surface": "#234567"}
        original_palette = deepcopy(palette)
        original_doc = deepcopy(self.doc)
        image = self.renderer.render(self.doc, palette=palette)
        self.assertEqual(image.getpixel((20, 400)), (0x12, 0x34, 0x56))
        self.assertEqual(image.getpixel((72, 260)), (0x23, 0x45, 0x67))
        self.assertEqual(palette, original_palette)
        self.assertEqual(self.doc, original_doc)

    def test_invalid_layout_and_pixel_budget_fail_before_allocating(self):
        invalid = deepcopy(self.doc)
        invalid["version"] = 2
        too_large = deepcopy(self.doc)
        too_large["canvas"] = {"width": 4096, "height": 4096}
        for document, message in ((invalid, "version"), (too_large, "16 million")):
            with self.subTest(message=message):
                with patch("turzx_studio.renderer.Image.new") as allocate:
                    with self.assertRaisesRegex(ValueError, message):
                        self.renderer.render(document)
                    allocate.assert_not_called()

    def test_custom_dimensions_are_rendered_without_scaling(self):
        document = deepcopy(self.doc)
        document["canvas"] = {"width": 600, "height": 500}
        document["widgets"] = [document["widgets"][0]]
        document["widgets"][0].update(x=0, y=120, width=100, height=100)
        image = self.renderer.render(document)
        self.assertEqual(image.size, (600, 500))
        self.assertEqual(image.getpixel((5, 170)), rgb(document["palette"]["surface"]))

    def test_live_metric_sources_bind_to_dashboard_attributes(self):
        cases = [
            ("cpu", "24", "%", "42 °C · 3600 MHz"),
            ("gpu", "18", "%", "55 °C · 6.2 / 16 GB VRAM"),
            ("memory", "12.4", "GB", "32 GB installed · 39% used"),
            ("disk", "61", "%", "122.4 / 200 GB"),
            ("network-down", "2.0", "MB/s", "Download · wlan0"),
            ("network-up", "512", "KB/s", "Upload · wlan0"),
        ]
        for source, value, unit, detail in cases:
            widget = deepcopy(self.doc["widgets"][0])
            widget["settings"]["source"] = source
            original = deepcopy(widget)
            with self.subTest(source=source):
                result = rendered_content(widget, self.stats)
                self.assertEqual(result["value"], value)
                self.assertEqual(result["unit"], unit)
                self.assertEqual(result["detail"], detail)
                self.assertEqual(result["label"], widget["settings"]["label"])
                self.assertEqual(widget, original)

    def test_sample_and_absent_sources_keep_saved_values_even_with_stats(self):
        for original in self.doc["widgets"]:
            for source in (None, "sample"):
                widget = deepcopy(original)
                widget["settings"].pop("source", None)
                if source is not None:
                    widget["settings"]["source"] = source
                actual = rendered_content(widget, self.stats)
                self.assertEqual(actual, widget["settings"])
                key = "value" if widget["type"] == "metric" else "temperature"
                actual[key] = "mutated snapshot"
                self.assertNotEqual(widget["settings"][key], "mutated snapshot")

    def test_stats_none_is_deterministic_even_for_live_sources(self):
        document = deepcopy(self.doc)
        for widget in document["widgets"]:
            widget["settings"]["source"] = "cpu" if widget["type"] == "metric" else "weather"
            self.assertEqual(rendered_content(widget), widget["settings"])
        self.assertEqual(self.renderer.render(document).tobytes(), self.renderer.render(document).tobytes())

    def test_missing_and_nonfinite_stats_use_dash(self):
        for source in ("cpu", "gpu", "memory", "disk", "network-down", "network-up"):
            widget = deepcopy(self.doc["widgets"][0])
            widget["settings"]["source"] = source
            self.assertEqual(rendered_content(widget, SimpleNamespace())["value"], "—")
        widget["settings"]["source"] = "cpu"
        for value in (None, float("nan"), float("inf"), True):
            with self.subTest(value=value):
                result = rendered_content(widget, SimpleNamespace(cpu_percent=value))
                self.assertEqual(result["value"], "—")
                self.assertEqual(result["detail"], "— °C · — MHz")

    def test_weather_live_bindings_show_unavailable_high_and_low(self):
        widget = deepcopy(next(widget for widget in self.doc["widgets"] if widget["type"] == "weather"))
        widget["settings"]["source"] = "weather"
        original = deepcopy(widget)
        actual = rendered_content(widget, self.stats)
        self.assertEqual(actual["location"], "Paris, FR")
        self.assertEqual(actual["temperature"], "19")
        self.assertEqual(actual["unit"], "°C")
        self.assertEqual(actual["condition"], "Partly cloudy")
        self.assertEqual(actual["high"], "—")
        self.assertEqual(actual["low"], "—")
        missing = rendered_content(widget, SimpleNamespace(weather_temp_c=None))
        self.assertEqual(missing["temperature"], "—")
        self.assertEqual(missing["location"], "—")
        self.assertEqual(missing["condition"], "—")
        self.assertEqual(missing["high"], "—")
        self.assertEqual(widget, original)

    def test_live_render_changes_clock_content_and_keeps_snapshots(self):
        document = deepcopy(self.doc)
        document["widgets"][0]["settings"]["source"] = "cpu"
        original_document = deepcopy(document)
        original_stats = deepcopy(vars(self.stats))
        offline = self.renderer.render(document)
        live = self.renderer.render(document, self.stats)
        self.assertNotEqual(offline.crop((1020, 47, 1216, 115)).tobytes(),
                            live.crop((1020, 47, 1216, 115)).tobytes())
        self.assertNotEqual(offline.crop((64, 731, 500, 760)).tobytes(),
                            live.crop((64, 731, 500, 760)).tobytes())
        self.assertEqual(document, original_document)
        self.assertEqual(vars(self.stats), original_stats)

    def test_fixed_precision_and_font_cache(self):
        widget = deepcopy(self.doc["widgets"][0])
        widget["settings"]["source"] = "cpu"
        first = rendered_content(widget, self.stats)
        self.stats.cpu_percent = 24.21
        self.stats.cpu_temp = 42.21
        self.stats.cpu_freq_mhz = 3600.21
        self.assertEqual(rendered_content(widget, self.stats), first)
        self.assertIs(self.renderer._font("mono", 58), self.renderer._font("mono", 58))


if __name__ == "__main__":
    unittest.main()
