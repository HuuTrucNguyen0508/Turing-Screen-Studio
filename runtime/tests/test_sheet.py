import copy
from datetime import datetime, timedelta, timezone
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
from turzx_studio.usage_display import UsageStats
from server import sheet_features

ROOT = Path(__file__).resolve().parents[2]
SHEET = json.loads((ROOT / "layouts/frost-sheet.json").read_text())
AI = json.loads((ROOT / "layouts/ai-usage-frost.json").read_text())
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

    def test_weather_block_sits_centred_between_the_date_and_the_slab_bottom(self):
        stats = SimpleNamespace(weather_temp_c=7, weather_description="Mist", weather_city="Éragny",
                                weather_feels_like_c=7, weather_humidity=93, weather_icon="50n")
        image = self.renderer.render(SHEET, stats=stats)
        weather = widget(SHEET, "weather")
        rows = [y for y in range(weather["y"], weather["y"] + weather["height"])
                if any(image.getpixel((x, y))[0] > 160 for x in range(weather["x"], weather["x"] + weather["width"]))]
        # The 260 px block spans 376..636: cap top of the 144 px temperature to the humidity line's descenders.
        self.assertTrue(388 <= min(rows) <= 402, min(rows))
        self.assertTrue(622 <= max(rows) <= 636, max(rows))

    def ink_columns(self, image, box, floor=160):
        x0, y0, x1, y1 = box
        lit = [x for x in range(x0, x1) if any(image.getpixel((x, y))[0] > floor for y in range(y0, y1))]
        return min(lit), max(lit)

    def weather_stats(self, clock="sam. 07 nov.  23:46", temperature=7, description="Mist", city="Éragny"):
        return SimpleNamespace(clock=clock, weather_temp_c=temperature, weather_description=description,
                               weather_city=city, weather_feels_like_c=temperature,
                               weather_humidity=93, weather_icon="50n")

    def weather_bands(self, image, weather):
        """Ink columns of the figure, the glyph + condition group and the two fact lines."""
        top = weather["y"] + (weather["height"] - 260) // 2
        x0, x1 = weather["x"], weather["x"] + weather["width"]
        names = ("figure", "condition", "place", "humidity")
        spans = ((0, 130), (160, 198), (208, 234), (234, 260))
        return {name: self.ink_columns(image, (x0, top + a, x1, top + b), 105) for name, (a, b) in zip(names, spans)}

    def test_the_whole_weather_block_is_centred_on_the_clock_for_any_time_and_either_dashboard(self):
        for layout in (SHEET, AI):
            for clock, temperature in (("sam. 07 nov.  23:46", 7), ("sam. 07 nov.  09:11", 19), ("sam. 07 nov.  12:00", -3)):
                with self.subTest(layout=layout["name"], clock=clock):
                    image = self.renderer.render(layout, stats=self.weather_stats(clock, temperature))
                    clock_box, weather = widget(layout, "clock"), widget(layout, "weather")
                    time_left, time_right = self.ink_columns(image, (clock_box["x"], clock_box["y"] + 20, clock_box["x"] + 480, clock_box["y"] + 175))
                    bands = self.weather_bands(image, weather)
                    for name, (left, right) in bands.items():
                        # Ink-centred; the facts and the condition are set by advance, so allow a few pixels.
                        self.assertAlmostEqual((left + right) / 2, (time_left + time_right) / 2, delta=2 if name == "figure" else 5, msg=name)
                    top = weather["y"] + (weather["height"] - 260) // 2
                    rows = [y for y in range(top, top + 130)
                            if any(image.getpixel((x, y))[0] > 160 for x in range(weather["x"], weather["x"] + weather["width"]))]
                    # Digit height of a 144 px ExtraLight figure; the 116 px one stood 83 px.
                    self.assertGreaterEqual(max(rows) - min(rows), 98)

    def test_long_weather_strings_stay_inside_the_widget(self):
        for layout in (SHEET, AI):
            with self.subTest(layout=layout["name"]):
                image = self.renderer.render(layout, stats=self.weather_stats(
                    description="Thunderstorm with heavy hail and strong winds", city="Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch"))
                weather = widget(layout, "weather")
                bands = self.weather_bands(image, weather)
                for name in ("condition", "place", "humidity"):
                    left, right = bands[name]
                    self.assertGreaterEqual(left, weather["x"], name)
                    self.assertLess(right, weather["x"] + weather["width"], name)
                # Clamped to the edge, not shrunk: the condition and place lines still fill most of the width.
                self.assertGreater(bands["place"][1] - bands["place"][0], weather["width"] * 0.8)

    def test_weather_without_a_clock_stays_left_aligned(self):
        doc = copy.deepcopy(SHEET)
        doc["widgets"] = [item for item in doc["widgets"] if item["type"] != "clock"]
        image = self.renderer.render(doc, stats=self.weather_stats())
        weather = widget(doc, "weather")
        bands = self.weather_bands(image, weather)
        self.assertLess(bands["place"][0] - weather["x"], 16)
        self.assertLess(bands["condition"][0] - weather["x"], 16)
        self.assertLess(bands["figure"][0] - weather["x"], 16)

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


def usage_snapshot(codex_five_hour=13, claude_weekly_stale=False, observed="2026-11-07T20:00:00Z"):
    """A collector snapshot shaped like GET /api/usage, served at 22:46 UTC."""
    def limit(ident, minutes, used, resets, weekly, stale=False):
        return {"id": ident, "windowMinutes": minutes, "usedPercent": used, "resetsAt": resets,
                "observedAt": observed, "stale": stale, "accountWeekly": weekly}
    tokens = {"observedAt": "2026-10-21T18:29:59Z", "stale": True, "status": "stale"}
    pricing = {"stale": False, "status": "cached"}
    return {
        "servedAt": "2026-11-07T22:46:00Z",
        "providers": {
            "codex": {"quotaWindows": {"five_hour": "supported", "weekly": "supported"}, "limits": [
                limit("primary", 300, codex_five_hour, "2026-11-08T00:53:07Z", False),
                limit("secondary", 10080, 90, "2026-11-11T12:38:58Z", True)]},
            "claude": {"quotaWindows": {"five_hour": "supported", "weekly": "supported"}, "limits": [
                limit("five_hour", 300, 32, "2026-11-07T21:00:00Z", False),
                limit("seven_day", 10080, 6, "2026-11-14T19:59:59Z", True, claude_weekly_stale)]},
        },
        "periods": {"last30days": {"providers": {
            "codex": {"total": 3466088872, "records": 27504, "costUSD": 960.76, "costKind": "estimate",
                      "freshness": {"tokens": tokens, "pricing": pricing}},
            "claude": {"total": 2435182078, "records": 15351, "costUSD": 1071.10, "costKind": "estimate",
                       "freshness": {"tokens": tokens, "pricing": pricing}},
            "cursor": {"total": None, "freshness": {"tokens": {"status": "unavailable", "stale": True}}},
        }}},
    }


class UsageSheetTests(unittest.TestCase):
    def setUp(self):
        self.renderer = LayoutRenderer(ground=fog)
        self.drawn = []
        original = self.renderer._ink_text

        def spy(ink, xy, text, *args, **kwargs):
            self.drawn.append(text)
            return original(ink, xy, text, *args, **kwargs)

        self.renderer._ink_text = spy

    def render(self, snapshot):
        return self.renderer.render(AI, stats=UsageStats(SimpleNamespace(), snapshot))

    def test_limits_draw_one_column_per_window_with_reset_countdowns(self):
        image = self.render(usage_snapshot(claude_weekly_stale=True))
        limits = self.drawn[:self.drawn.index("Tokens")]
        self.assertEqual([text for text in limits if text in ("Codex", "Claude")], ["Codex", "Claude"])
        self.assertEqual([text for text in self.drawn if text.endswith("%") or text == "–"], ["13%", "90%", "32%", "6%"])
        # Dated in the panel's local time, like its clock.
        local = datetime(2026, 11, 7, 20, 0, tzinfo=timezone.utc).astimezone().strftime("%H:%M")
        for fact in ("2h 08m", "3d 13h", "6d 21h", "reset pending", f"as of {local}"):
            self.assertIn(fact, self.drawn)
        # Codex weekly meter: 90 % of a 132 px column that starts at x 744.
        limits = widget(AI, "usage-limits")
        meter_y = limits["y"] + 161
        lit = [x for x in range(744, 744 + 132) if image.getpixel((x, meter_y))[0] > 200]
        self.assertEqual((min(lit), max(lit)), (744, 744 + 118))

    def test_a_recent_stale_reading_is_not_dated(self):
        recent = (datetime.now(timezone.utc) - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.render(usage_snapshot(claude_weekly_stale=True, observed=recent))
        self.assertFalse(any(text.startswith("as of") for text in self.drawn), self.drawn)

    def test_an_unknown_quota_shows_a_dash_and_an_empty_track(self):
        snapshot = usage_snapshot(codex_five_hour=None)
        image = self.render(snapshot)
        self.assertIn("–", self.drawn)
        self.assertIn("unavailable", self.drawn)
        meter_y = widget(AI, "usage-limits")["y"] + 161
        self.assertFalse(any(image.getpixel((x, meter_y))[0] > 200 for x in range(588, 588 + 132)))

    def test_totals_show_the_sum_with_provider_facts_and_whole_dollars(self):
        snapshot = usage_snapshot()
        snapshot["periods"]["last30days"]["providers"]["cursor"] = {
            "total": 0, "records": 0, "costUSD": 0, "costKind": "estimate",
            "freshness": {"tokens": {"status": "cached", "stale": False}, "pricing": {"stale": False}}}
        self.render(snapshot)
        for text in ("5.9B", "3.5B", "2.4B", "Codex", "Claude", "Last 30 days, as of 21 Oct",
                     "$2\u2009032", "$961", "$1\u2009071", "API estimate, last 30 days, as of 21 Oct"):
            self.assertIn(text, self.drawn)
        self.assertNotIn("Cursor", self.drawn)

    def test_a_provider_without_a_cache_is_left_out_and_nothing_is_called_partial(self):
        # Cursor's scan entry is missing, as it has been since its subscription ended.
        self.render(usage_snapshot())
        for text in ("5.9B", "Last 30 days, as of 21 Oct", "$2\u2009032", "API estimate, last 30 days, as of 21 Oct", "Codex", "Claude"):
            self.assertIn(text, self.drawn)
        self.assertNotIn("Cursor", self.drawn)
        self.assertFalse([text for text in self.drawn if text.startswith("Partial")], self.drawn)
        self.assertFalse(any(text.endswith("…") for text in self.drawn), self.drawn)

    def test_a_provider_with_data_that_is_missing_makes_the_total_partial_without_truncating_facts(self):
        snapshot = usage_snapshot()
        snapshot["periods"]["last30days"]["providers"]["claude"].update(total=None, costUSD=None, costKind="unavailable")
        self.render(snapshot)
        for text in ("Partial, last 30 days, as of 21 Oct", "Partial estimate, last 30 days, as of 21 Oct", "Claude", "—"):
            self.assertIn(text, self.drawn)
        self.assertFalse(any(text.endswith("…") for text in self.drawn), self.drawn)

    def test_missing_usage_reads_unavailable_instead_of_sample_values(self):
        self.render({})
        self.assertIn("Usage unavailable", self.drawn)
        self.assertIn("API estimate unavailable", self.drawn)
        self.assertNotIn("5.9B", self.drawn)
        self.assertEqual([text for text in self.drawn if text.endswith("%")], [])

    def test_ai_usage_shares_the_fog_column_rules_and_threads_with_system_overview(self):
        system, ai = (self.renderer.render(doc) for doc in (SHEET, AI))
        for box in ((0, 0, 560, 800), (560, 540, 1216, 736), (0, 736, 1280, 800)):
            self.assertEqual(system.crop(box).tobytes(), ai.crop(box).tobytes(), box)

    def test_usage_styles_require_their_sources(self):
        for identifier, source, message in (("usage-limits", "usage-cost-30d", "figures require the usage-limits source"),
                                            ("usage-cost", "usage-limits", "total require the usage-tokens-30d or usage-cost-30d source")):
            with self.subTest(identifier=identifier):
                doc = copy.deepcopy(AI)
                widget(doc, identifier)["settings"]["source"] = source
                with self.assertRaisesRegex(ValueError, message):
                    validate_layout(doc)


if __name__ == "__main__":
    unittest.main()
