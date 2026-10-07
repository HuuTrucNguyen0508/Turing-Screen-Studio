"""Offline clock placement, contract and clipped text rendering."""

from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image, ImageChops, ImageDraw

from turzx_studio.design import resolve_elements, update_widget_design, validate_widget_design
from turzx_studio.layout import parse_layout, serialize_layout, validate_layout
from turzx_studio.renderer import LayoutRenderer

ROOT = Path(__file__).resolve().parents[2]
PANEL_FONTS = Path.home() / "Documents/turing-smart-screen-python/res/fonts"


def clock():
    return {"id": "clock", "type": "clock", "x": 100, "y": 200,
            "width": 270, "height": 80,
            "settings": {"label": "Local time", "time": "14:32",
                         "date": "Tuesday, 6 October", "format": "24h",
                         "showDate": True, "source": "clock"}}


def document(widget=None):
    doc = parse_layout((ROOT / "public/sample-layout.json").read_text())
    doc["widgets"] = [widget or clock()]
    return doc


class DesignTests(unittest.TestCase):
    def test_exact_default_baselines_alignment_padding_and_content_visibility(self):
        widget = clock()
        self.assertEqual([(e["x"], e["y"], e["hidden"]) for e in resolve_elements(widget)],
                         [(29, 22, True), (29, 39, False), (29, 66, False)])
        for align, expected in (("start", 29), ("center", 135), ("end", 241)):
            widget["design"] = {"elements": {"time": {"align": align}}}
            self.assertEqual(resolve_elements(widget)[1]["x"], expected)
        widget["design"] = {"padding": 40, "elements": {"time": {"align": "end"}, "date": {"hidden": False}}}
        self.assertEqual(resolve_elements(widget)[1]["x"], 230)
        widget["settings"]["showDate"] = False
        self.assertTrue(resolve_elements(widget)[2]["hidden"])
        self.assertEqual(resolve_elements(widget)[1]["y"], 50)
        widget["height"] = 184
        self.assertEqual(resolve_elements(widget)[1]["y"], 110)
        self.assertEqual(resolve_elements(widget)[1]["size"], 72)

    def test_validation_order_detachment_empty_objects_and_paths(self):
        raw = {"elements": {"date": {"color": "secondary"},
                            "time": {"size": 81, "dy": 0, "align": "center", "hidden": False}},
               "padding": 40}
        doc = document({**clock(), "design": raw})
        canonical = validate_layout(doc)
        design = canonical["widgets"][0]["design"]
        self.assertEqual(list(design), ["padding", "elements"])
        self.assertEqual(list(design["elements"]), ["time", "date"])
        self.assertEqual(list(design["elements"]["time"]), ["hidden", "align", "dy", "size"])
        design["elements"]["time"]["size"] = 40
        self.assertEqual(raw["elements"]["time"]["size"], 81)
        self.assertEqual(serialize_layout(parse_layout(serialize_layout(doc))), serialize_layout(doc))
        for value, path, message in (
            ({}, "", "remove the empty object"),
            ({"elements": {}}, ".elements", "remove the empty object"),
            ({"elements": {"time": {}}}, ".elements.time", "remove the empty object"),
            ({"elements": {"time": {"dy": 600}}}, ".elements.time.dy", "must be between -512 and 512"),
            ({"elements": {"time": {"dx": 1.5}}}, ".elements.time.dx", "expected a safe integer"),
            ({"padding": True}, ".padding", "expected a safe integer"),
        ):
            with self.subTest(value=value):
                with self.assertRaises(ValueError) as error:
                    validate_widget_design(value, "clock", "$.widgets[0].design")
                self.assertEqual(str(error.exception), f"$.widgets[0].design{path}: {message}")

    def test_updates_prune_resets_and_do_not_mutate_or_duplicate_no_ops(self):
        original = document()
        self.assertIs(update_widget_design(original, "clock", {"reset": True}), original)
        designed = update_widget_design(original, "clock", {"element": "time", "set": {"align": "center"}})
        self.assertNotIn("design", original["widgets"][0])
        self.assertIs(update_widget_design(designed, "clock", {"element": "time", "set": {"align": "center"}}), designed)
        reset = update_widget_design(designed, "clock", {"element": "time", "reset": True})
        self.assertNotIn("design", reset["widgets"][0])
        self.assertEqual(serialize_layout(reset), serialize_layout(original))

    def test_no_design_keeps_legacy_clock_painter_and_content_does_not_mutate(self):
        renderer = LayoutRenderer()
        widget = clock()
        with patch.object(renderer, "_clock", wraps=renderer._clock) as legacy:
            renderer.render(document(widget))
            legacy.assert_called_once()
        widget["design"] = {"elements": {"time": {"align": "center"}}}
        before = deepcopy(widget)
        with patch.object(renderer, "_clock", wraps=renderer._clock) as legacy, \
                patch.object(renderer, "_designed_text", wraps=renderer._designed_text) as designed:
            renderer.render(document(widget), SimpleNamespace(clock="Wed 07 Oct  20:01:59"))
            legacy.assert_not_called()
            elements = designed.call_args.args[1]
            self.assertEqual(elements[1]["text"], "20:01")
            self.assertEqual(elements[1]["x"], 135)
            self.assertEqual(elements[2]["text"], "Wed 07 Oct")
        self.assertEqual(widget, before)

    def test_offsets_clip_at_card_boundaries_for_full_renderer(self):
        renderer = LayoutRenderer()
        widget = clock()
        widget["design"] = {"elements": {"label": {"hidden": True}, "time": {"hidden": True}, "date": {"hidden": True}}}
        blank = renderer.render(document(widget))
        for offsets in ({"dy": 512}, {"dy": -512}, {"dx": -512}, {"dx": 160}):
            candidate = deepcopy(widget)
            candidate["design"]["elements"]["time"] = offsets
            rendered = renderer.render(document(candidate))
            bounds = ImageChops.difference(blank, rendered).getbbox()
            with self.subTest(offsets=offsets):
                if bounds is not None:
                    self.assertGreaterEqual(bounds[0], widget["x"])
                    self.assertGreaterEqual(bounds[1], widget["y"])
                    self.assertLessEqual(bounds[2], widget["x"] + widget["width"])
                    self.assertLessEqual(bounds[3], widget["y"] + widget["height"])
                else:
                    self.assertNotEqual(offsets, {"dx": 160})

    def assert_text_alignment(self, renderer):
        palette = dict.fromkeys(("text", "muted", "primary", "secondary"), "#ffffff")
        for align in ("center", "end"):
            for format in ("24h", "12h"):
                widget = clock()
                widget["settings"]["format"] = format
                widget["design"] = {"elements": {"time": {"align": align}}}
                element = resolve_elements(widget)[1]
                image = Image.new("RGB", (270, 80), "#000000")
                draw = ImageDraw.Draw(image)
                with patch.object(renderer, "_draw_text", wraps=renderer._draw_text) as calls:
                    renderer._designed_text(draw, [element], palette)
                box = image.getbbox()
                with self.subTest(align=align, format=format):
                    self.assertIsNotNone(box)
                    if align == "center":
                        self.assertAlmostEqual((box[0] + box[2]) / 2, 135, delta=1)
                    else:
                        self.assertLessEqual(box[2], 242)
                        self.assertGreaterEqual(box[2], 238)
                    if format == "12h":
                        self.assertEqual(len(calls.call_args_list), 2)
                        self.assertEqual([call.args[1][1] for call in calls.call_args_list], [39, 39])
                        self.assertEqual([call.args[6] for call in calls.call_args_list], ["ls", "ls"])

    @unittest.skipUnless(Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf").exists(), "DejaVu fonts absent")
    def test_ink_alignment_with_dejavu_and_shared_suffix_baseline(self):
        self.assert_text_alignment(LayoutRenderer())

    @unittest.skipUnless((PANEL_FONTS / "jetbrains-mono/JetBrainsMono-Regular.ttf").exists()
                         and (PANEL_FONTS / "roboto/Roboto-Regular.ttf").exists(), "Panel fonts absent")
    def test_ink_alignment_with_panel_fonts(self):
        self.assert_text_alignment(LayoutRenderer(PANEL_FONTS))

    def test_every_legacy_preset_and_sample_remain_without_design(self):
        docs = [document()]
        docs.extend(entry["document"] for entry in json.loads((ROOT / "public/layout-presets.json").read_text())["presets"])
        for doc in docs:
            canonical = parse_layout(serialize_layout(doc))
            self.assertTrue(all("design" not in widget for widget in canonical["widgets"]))


if __name__ == "__main__":
    unittest.main()
