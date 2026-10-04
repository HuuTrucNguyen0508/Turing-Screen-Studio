"""File watching tests using temporary JSON files and no background runtime."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from turzx_studio.layout import parse_layout, revision, serialize_layout
from turzx_studio.watch import LayoutWatcher, MAX_LAYOUT_BYTES

SAMPLE_PATH = Path(__file__).resolve().parents[2] / "public" / "sample-layout.json"


class WatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "layout.json"
        self.doc = parse_layout(SAMPLE_PATH.read_text(encoding="utf-8"))
        self.watcher = LayoutWatcher(self.path)

    def write(self, text):
        previous = self.path.stat().st_mtime_ns if self.path.exists() else 0
        self.path.write_text(text, encoding="utf-8")
        info = self.path.stat()
        modified = max(info.st_mtime_ns, previous + 1_000_000)
        os.utime(self.path, ns=(info.st_atime_ns, modified))

    def test_missing_startup_is_helpful_and_recovers(self):
        self.assertIsNone(self.watcher.document)
        self.assertIsNone(self.watcher.revision)
        self.assertIsNone(self.watcher.poll())
        self.assertIn(str(self.path), self.watcher.error)
        self.assertIn("Save a layout", self.watcher.error)
        self.write(serialize_layout(self.doc))
        self.assertEqual(self.watcher.poll(), self.doc)
        self.assertEqual(self.watcher.revision, revision(self.doc))
        self.assertIsNone(self.watcher.error)

    def test_stat_cache_skips_unchanged_reads(self):
        self.write(serialize_layout(self.doc))
        with patch("turzx_studio.watch.parse_layout", wraps=parse_layout) as parser:
            self.assertEqual(self.watcher.poll(), self.doc)
            for _ in range(4):
                self.assertIsNone(self.watcher.poll())
            self.assertEqual(parser.call_count, 1)

    def test_touch_or_format_change_does_not_change_revision(self):
        self.write(serialize_layout(self.doc))
        self.watcher.poll()
        original_revision = self.watcher.revision
        self.write(serialize_layout(self.doc))
        self.assertIsNone(self.watcher.poll())
        self.write(json.dumps(dict(reversed(list(self.doc.items()))), ensure_ascii=False))
        self.assertIsNone(self.watcher.poll())
        self.assertEqual(self.watcher.revision, original_revision)
        changed = deepcopy(self.doc)
        changed["widgets"][0]["x"] += 1
        self.write(serialize_layout(changed))
        self.assertEqual(self.watcher.poll(), changed)
        self.assertNotEqual(self.watcher.revision, original_revision)

    def test_invalid_and_deleted_files_keep_last_valid_document(self):
        self.write(serialize_layout(self.doc))
        self.watcher.poll()
        original_revision = self.watcher.revision
        for invalid in ('{"version": 2}', '{"version": 1,', "null"):
            self.write(invalid)
            self.assertIsNone(self.watcher.poll())
            self.assertEqual(self.watcher.document, self.doc)
            self.assertEqual(self.watcher.revision, original_revision)
            self.assertIn(str(self.path), self.watcher.error)
            with patch("turzx_studio.watch.parse_layout", side_effect=AssertionError("cached invalid file")):
                self.assertIsNone(self.watcher.poll())
        self.path.unlink()
        self.assertIsNone(self.watcher.poll())
        self.assertEqual(self.watcher.document, self.doc)
        self.assertEqual(self.watcher.revision, original_revision)
        self.assertIn("not found", self.watcher.error)
        self.write(serialize_layout(self.doc))
        self.assertIsNone(self.watcher.poll())
        self.assertIsNone(self.watcher.error)

    def test_same_size_invalid_edit_and_atomic_replacement(self):
        original = serialize_layout(self.doc)
        self.write(original)
        self.watcher.poll()
        self.write(original.replace('"version": 1', '"version": 2', 1))
        self.assertIsNone(self.watcher.poll())
        self.assertIn("$.version", self.watcher.error)
        changed = deepcopy(self.doc)
        changed["widgets"][0]["x"] += 1
        replacement = self.path.with_name("replacement.json")
        replacement.write_text(serialize_layout(changed), encoding="utf-8")
        info = self.path.stat()
        os.utime(replacement, ns=(info.st_atime_ns, info.st_mtime_ns))
        os.replace(replacement, self.path)
        self.assertEqual(self.watcher.poll(), changed)
        self.assertEqual(self.watcher.revision, revision(changed))

    def test_size_limit_and_non_utf8_keep_valid_content(self):
        self.write(serialize_layout(self.doc))
        self.watcher.poll()
        self.path.write_bytes(b" " * (MAX_LAYOUT_BYTES + 1))
        with patch("turzx_studio.watch.parse_layout", side_effect=AssertionError("oversized file parsed")):
            self.assertIsNone(self.watcher.poll())
        self.assertIn("1 MB", self.watcher.error)
        self.assertEqual(self.watcher.document, self.doc)
        self.path.write_bytes(b"\xff\xfe")
        self.assertIsNone(self.watcher.poll())
        self.assertIsNotNone(self.watcher.error)
        self.assertEqual(self.watcher.document, self.doc)

    def test_nonregular_file_and_panel_validation(self):
        self.path.mkdir()
        self.assertIsNone(self.watcher.poll())
        self.assertIn("regular JSON file", self.watcher.error)
        self.path.rmdir()
        document = deepcopy(self.doc)
        document["widgets"] = []
        document["canvas"] = {"width": 200, "height": 100}
        self.write(serialize_layout(document))
        panel_watcher = LayoutWatcher(self.path, panel=True)
        self.assertIsNone(panel_watcher.poll())
        self.assertIn("1280 by 800", panel_watcher.error)
        self.assertEqual(self.watcher.poll(), document)

    def test_file_changed_during_read_is_retried_without_publishing(self):
        self.write(serialize_layout(self.doc))
        info = self.path.stat()
        changed = SimpleNamespace(st_size=info.st_size, st_mtime_ns=info.st_mtime_ns + 1,
                                  st_ino=info.st_ino, st_mode=info.st_mode)
        with patch("turzx_studio.watch.os.fstat", side_effect=[info, changed]):
            self.assertIsNone(self.watcher.poll())
        self.assertIsNone(self.watcher.document)
        self.assertIn("changed while reading", self.watcher.error)
        self.assertEqual(self.watcher.poll(), self.doc)
        self.assertIsNone(self.watcher.error)

    def test_snapshots_are_detached_for_concurrent_readers(self):
        self.write(serialize_layout(self.doc))
        first = self.watcher.poll()
        first["widgets"][0]["x"] = 0
        first["palette"]["background"] = "#ffffff"

        def reader(_):
            snapshot = self.watcher.document
            snapshot["widgets"][0]["settings"]["value"] = "changed"
            self.watcher.poll()
            return self.watcher.revision

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(reader, range(12)))
        self.assertEqual(results, [revision(self.doc)] * 12)
        self.assertEqual(self.watcher.document, self.doc)
        self.assertEqual(parse_layout(self.path.read_text(encoding="utf-8")), self.doc)


if __name__ == "__main__":
    unittest.main()
