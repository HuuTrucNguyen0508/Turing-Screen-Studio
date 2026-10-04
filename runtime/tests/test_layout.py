"""Contract tests shared with the editor's saved JSON corpus."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest

from turzx_studio.layout import (
    PALETTE_ROLES,
    effective_palette,
    parse_caelestia_palette,
    parse_layout,
    revision,
    serialize_layout,
    validate_layout,
)

SAMPLE_PATH = Path(__file__).resolve().parents[2] / "public" / "sample-layout.json"


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.sample_text = SAMPLE_PATH.read_text(encoding="utf-8")
        self.doc = parse_layout(self.sample_text)

    def test_sample_matches_editor_serialization_and_roundtrips(self):
        expected = json.dumps(json.loads(self.sample_text), indent=2, ensure_ascii=False) + "\n"
        self.assertEqual(serialize_layout(self.doc), expected)
        self.assertEqual(parse_layout(serialize_layout(self.doc)), self.doc)
        self.assertEqual(validate_layout(self.doc, panel=True), self.doc)

    def test_detached_canonical_key_order(self):
        scrambled = dict(reversed(list(self.doc.items())))
        scrambled["canvas"] = dict(reversed(list(self.doc["canvas"].items())))
        scrambled["palette"] = dict(reversed(list(self.doc["palette"].items())))
        scrambled["widgets"] = [
            dict(reversed(list(widget.items()))) for widget in self.doc["widgets"]
        ]
        normalized = validate_layout(scrambled)
        self.assertEqual(list(normalized), ["version", "name", "canvas", "palette", "widgets"])
        self.assertEqual(list(normalized["canvas"]), ["width", "height"])
        self.assertEqual(list(normalized["palette"]), ["name", *PALETTE_ROLES])
        self.assertEqual(list(normalized["widgets"][0]), [
            "id", "type", "x", "y", "width", "height", "settings",
        ])
        self.assertEqual(serialize_layout(normalized), serialize_layout(self.doc))
        normalized["canvas"]["width"] = 1
        normalized["widgets"][0]["settings"]["value"] = "changed"
        self.assertEqual(scrambled["canvas"]["width"], 1280)
        self.assertNotEqual(scrambled["widgets"][0]["settings"]["value"], "changed")

    def test_version_failure_precedes_other_fields(self):
        for value in ({}, {"name": 4}, {"version": 2, "extra": 3},
                      {"version": True}, {"version": 1.5}):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, r"^\$\.version:"):
                validate_layout(value)

    def test_invalid_field_corpus_has_actionable_paths(self):
        cases = [
            (("name",), "  ", "$.name"),
            (("canvas", "width"), True, "$.canvas.width"),
            (("canvas", "height"), 800.25, "$.canvas.height"),
            (("canvas", "width"), 0, "$.canvas.width"),
            (("canvas", "height"), 16385, "$.canvas.height"),
            (("palette", "primary"), "#fff", "$.palette.primary"),
            (("palette", "surface"), "123456", "$.palette.surface"),
            (("widgets", 0, "id"), "\t ", "$.widgets[0].id"),
            (("widgets", 1, "id"), self.doc["widgets"][0]["id"], "$.widgets[1].id"),
            (("widgets", 0, "type"), "unknown", "$.widgets[0].type"),
            (("widgets", 0, "x"), -1, "$.widgets[0].x"),
            (("widgets", 0, "y"), False, "$.widgets[0].y"),
            (("widgets", 0, "width"), 3.5, "$.widgets[0].width"),
            (("widgets", 0, "height"), 0, "$.widgets[0].height"),
            (("widgets", 0, "x"), 2**53, "$.widgets[0].x"),
            (("widgets", 0, "width"), 1280, "$.widgets[0].width"),
            (("widgets", 0, "height"), 800, "$.widgets[0].height"),
            (("widgets", 0, "settings", "value"), None, "$.widgets[0].settings.value"),
            (("widgets", 3, "settings", "high"), 24, "$.widgets[3].settings.high"),
            (("widgets",), {}, "$.widgets"),
            (("paletteMode",), "auto", "$.paletteMode"),
        ]
        for keys, value, path in cases:
            document = deepcopy(self.doc)
            target = document
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = value
            with self.subTest(path=path, value=value):
                with self.assertRaises(ValueError) as caught:
                    validate_layout(document)
                self.assertTrue(str(caught.exception).startswith(path + ":"), str(caught.exception))

    def test_missing_and_unknown_fields(self):
        for keys in ((), ("canvas",), ("palette",), ("widgets", 0),
                     ("widgets", 0, "settings"), ("widgets", 3, "settings")):
            for action in ("missing", "extra"):
                document = deepcopy(self.doc)
                target = document
                for key in keys:
                    target = target[key]
                if action == "missing":
                    target.pop(next(iter(target)))
                else:
                    target["unexpected"] = 1
                with self.subTest(keys=keys, action=action), self.assertRaises(ValueError):
                    validate_layout(document)

    def test_one_pixel_card_and_canvas_limits(self):
        document = deepcopy(self.doc)
        document["widgets"] = [document["widgets"][0]]
        document["widgets"][0].update(x=1279, y=799, width=1, height=1)
        self.assertEqual(validate_layout(document)["widgets"][0]["width"], 1)
        document["canvas"] = {"width": 16384, "height": 16384}
        self.assertEqual(validate_layout(document)["canvas"]["width"], 16384)
        with self.assertRaisesRegex(ValueError, r"\$\.canvas:.*1280 by 800"):
            validate_layout(document, panel=True)

    def test_integer_valued_json_numbers_match_typescript_and_canonicalize(self):
        text = self.sample_text.replace('"version": 1,', '"version": 1.0,', 1)
        text = text.replace('"width": 1280,', '"width": 1280.0,', 1)
        document = parse_layout(text)
        self.assertEqual(document, self.doc)
        self.assertIs(type(document["version"]), int)
        self.assertIs(type(document["canvas"]["width"]), int)
        self.assertEqual(serialize_layout(document), serialize_layout(self.doc))

    def test_sources_and_palette_mode_preserve_optional_presence(self):
        document = deepcopy(self.doc)
        for widget in document["widgets"]:
            widget["settings"].pop("source", None)
        document.pop("paletteMode", None)
        self.assertNotIn("paletteMode", validate_layout(document))
        self.assertNotIn("source", validate_layout(document)["widgets"][0]["settings"])
        for mode in ("saved", "live"):
            document["paletteMode"] = mode
            for source in ("sample", "cpu", "gpu", "memory", "disk", "network-down", "network-up"):
                document["widgets"][0]["settings"]["source"] = source
                normalized = validate_layout(document)
                self.assertEqual(list(normalized)[-1], "paletteMode")
                self.assertEqual(list(normalized["widgets"][0]["settings"]), [
                    "label", "value", "unit", "detail", "source",
                ])
                self.assertEqual(parse_layout(serialize_layout(document)), normalized)
        for source in ("sample", "weather"):
            document["widgets"][3]["settings"]["source"] = source
            self.assertEqual(validate_layout(document)["widgets"][3]["settings"]["source"], source)
        for index, source in ((0, "weather"), (3, "cpu"), (0, False), (3, "other")):
            invalid = deepcopy(self.doc)
            invalid["widgets"][index]["settings"]["source"] = source
            with self.assertRaisesRegex(ValueError, "settings.source"):
                validate_layout(invalid)

    def test_strict_json_rejects_duplicates_nonfinite_and_malformed_text(self):
        invalid = [
            self.sample_text.replace('"version": 1,', '"version": 1, "version": 1,', 1),
            self.sample_text.replace('"width": 1280,', '"width": 1280, "width": 1280,', 1),
            self.sample_text.replace('"label": "CPU load",', '"label": "CPU load", "label": "GPU",', 1),
            self.sample_text.replace('"width": 1280', '"width": NaN', 1),
            self.sample_text.replace('"width": 1280', '"width": Infinity', 1),
            self.sample_text.replace('"width": 1280', '"width": -Infinity', 1),
            self.sample_text.replace('"width": 1280', '"width": 1e999', 1),
            self.sample_text[:-2], "null", "[]", '{"version": 1,}',
        ]
        for text in invalid:
            with self.subTest(text=text[:90]), self.assertRaises(ValueError):
                parse_layout(text)
        nested_duplicate = self.sample_text.replace('"width": 1280,', '"width": 1280, "width": 1,', 1)
        with self.assertRaisesRegex(ValueError, r"\$\.canvas.width: duplicate"):
            parse_layout(nested_duplicate)

    def test_unicode_and_lone_surrogates_serialize_as_utf8_json(self):
        document = deepcopy(self.doc)
        document["name"] = "Paris · 19 °C ☀ 🖥"
        text = serialize_layout(document)
        self.assertIn(document["name"], text)
        self.assertTrue(text.endswith("\n"))
        self.assertEqual(parse_layout(text.encode("utf-8").decode("utf-8")), document)
        document["name"] = "bad\ud800"
        text = serialize_layout(document)
        self.assertIn(r"bad\ud800", text)
        self.assertEqual(parse_layout(text), document)

    def test_revision_hashes_canonical_content(self):
        expected = hashlib.sha256(serialize_layout(self.doc).encode("utf-8")).hexdigest()
        self.assertEqual(revision(self.doc), expected)
        reordered = json.dumps(dict(reversed(list(self.doc.items()))), ensure_ascii=False)
        self.assertEqual(revision(parse_layout(reordered)), expected)
        changed = deepcopy(self.doc)
        changed["widgets"][0]["x"] += 1
        self.assertNotEqual(revision(changed), expected)

    def test_caelestia_colours_colors_and_existing_roles(self):
        mapping = dict(zip(PALETTE_ROLES, (
            "background", "surfaceContainer", "surfaceContainerHigh", "onSurface",
            "onSurfaceVariant", "primary", "secondary", "outlineVariant",
        )))
        expected = {"name": "scheme", **{role: "#aabbcc" for role in PALETTE_ROLES}}
        for container in ("colours", "colors"):
            scheme = {"name": "scheme", container: {key: "AABBCC" for key in mapping.values()}}
            scheme[container]["unused"] = "metadata"
            self.assertEqual(parse_caelestia_palette(json.dumps(scheme)), expected)
            scheme[container].pop("onSurface")
            with self.assertRaisesRegex(ValueError, "onSurface"):
                parse_caelestia_palette(json.dumps(scheme))
        roles = {"name": "scheme", **{role: "#AABBCC" for role in PALETTE_ROLES}}
        self.assertEqual(parse_caelestia_palette(json.dumps(roles)), expected)
        roles["primary"] = "bad"
        with self.assertRaisesRegex(ValueError, "primary"):
            parse_caelestia_palette(json.dumps(roles))

    def test_effective_palette_saved_live_and_fallback_are_detached(self):
        live = {**self.doc["palette"], "name": "live", "background": "#ffffff"}
        document = deepcopy(self.doc)
        document.pop("paletteMode", None)
        self.assertEqual(effective_palette(document, live), document["palette"])
        document["paletteMode"] = "saved"
        self.assertEqual(effective_palette(document, live), document["palette"])
        document["paletteMode"] = "live"
        self.assertEqual(effective_palette(document), document["palette"])
        actual = effective_palette(document, live)
        self.assertEqual(actual, live)
        actual["background"] = "#000000"
        self.assertEqual(live["background"], "#ffffff")


if __name__ == "__main__":
    unittest.main()
