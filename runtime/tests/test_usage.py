"""Collector contracts using synthetic local files, never real accounts."""

from datetime import datetime, timezone
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from turzx_studio import usage


NOW = datetime(2026, 10, 6, 19, 30, tzinfo=timezone.utc).timestamp()


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.base = self.home / ".t3/userdata"
        self.base.mkdir(parents=True)
        self.now = NOW
        self.mountinfo = self.home / "mountinfo"
        self.mountinfo.write_text("1 0 8:1 / / rw - btrfs /dev/root rw\n"
                                  "2 1 8:1 /home /home rw - btrfs /dev/root rw\n"
                                  "3 1 8:2 / /mnt/games rw - fuseblk /dev/sdb1 rw\n")
        self.mounted_calls = []

        def mounted_disk(path):
            self.mounted_calls.append(path)
            return SimpleNamespace(total=100 * 1024**3, used=40 * 1024**3, free=55 * 1024**3)

        self.collector = usage.UsageCollector(self.home, lambda: self.now,
                                              mountinfo_path=self.mountinfo, disk_usage=mounted_disk)

    def write_json(self, name, document):
        path = self.base / name
        path.write_text(json.dumps(document), encoding="utf-8")
        return path

    @staticmethod
    def row(model=0, session=0, tokens=(10, 20, 30, 40, 5), key=None, cost=None, speed=0, stamp=NOW):
        return [int(stamp * 1000), model, session, *tokens, key, cost, speed]

    def cache(self, files=None, models=None, sessions=None):
        if files is None:
            files = {"/private/.codex-pro/sessions/a.jsonl": {"p": "codex", "s": 10, "m": NOW * 1000, "r": [self.row()], "t": []}}
        return self.write_json("usage-scan-cache-v5.json", {"version": 5, "models": models or ["model-a"],
                                                         "sessions": sessions or ["session-a"], "files": files})

    def rates(self, document=None):
        if document is None:
            document = {"model-a": {"input_cost_per_token": .01, "output_cost_per_token": .02,
                                     "cache_read_input_token_cost": .001, "cache_creation_input_token_cost": .0125}}
        return self.write_json("usage-model-rates.json", {"fetchedAtMs": NOW * 1000, "document": document})

    def event(self, percent=42, stamp=NOW, duration=10080, reset=None, secondary=None):
        return {"timestamp": usage._iso(stamp), "type": "event_msg", "payload": {"type": "token_count", "rate_limits": {
            "primary": {"used_percent": percent, "window_minutes": duration, "resets_at": reset or NOW + 3600},
            "secondary": secondary}}}

    def quota(self, events=None, name="a.jsonl", codex_home=".codex-pro"):
        root = self.home / codex_home / "sessions/2026/10/06"
        root.mkdir(parents=True, exist_ok=True)
        path = root / name
        path.write_text("".join(json.dumps(event) + "\n" for event in events or [self.event()]), encoding="utf-8")
        return path

    def notices(self, rows=None):
        path = self.base / "statev2.sqlite"
        with closing(sqlite3.connect(path)) as connection, connection:
            connection.execute("CREATE TABLE orchestration_v2_projection_turn_items (type TEXT, updated_at TEXT, payload_json TEXT)")
            rows = rows or [("system_notice", NOW, {"message": "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 3h 25m."})]
            connection.executemany("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?)",
                                   [(kind, usage._iso(stamp), json.dumps(payload)) for kind, stamp, payload in rows])
        return path

    def provider(self, name="codex"):
        return self.collector.snapshot()["providers"][name]

    def test_verified_v5_tuple_order_and_cached_input_not_counted_twice(self):
        self.cache()
        self.rates()
        value = self.provider()
        self.assertEqual({key: value[key] for key in usage.TOKEN_FIELDS},
                         {"input": 10, "cacheRead": 20, "cacheWrite": 30, "output": 40, "reasoning": 5})
        self.assertEqual(value["cache"], 50)
        self.assertEqual(value["total"], 100)
        self.assertAlmostEqual(value["costUSD"], 1.295)
        self.assertEqual(value["costKind"], "estimate")
        self.assertEqual(value["perModel"][0]["model"], "model-a")
        self.assertEqual(value["latestRecordAt"], usage._iso(NOW))

    def test_claude_message_deduplication_including_tail_records(self):
        row = self.row(key="message:request")
        second = self.row(key="message-two:request", tokens=(1, 2, 3, 4, 0))
        self.cache({"first": {"p": "claude", "r": [row], "t": [second]},
                    "forked-copy": {"p": "claude", "r": [row], "t": [second]}})
        value = self.provider("claude")
        self.assertEqual(value["records"], 2)
        self.assertEqual(value["total"], 110)
        self.assertEqual(value["duplicatesDropped"], 2)

    def test_codex_copied_rollout_dedup_preserves_occurrences_in_original(self):
        row = self.row()
        self.cache({"original": {"p": "codex", "r": [row, row], "t": []},
                    "moved": {"p": "codex", "r": [row, row], "t": []}})
        value = self.provider()
        self.assertEqual(value["records"], 2)
        self.assertEqual(value["total"], 200)
        self.assertEqual(value["duplicatesDropped"], 2)

    def test_different_sessions_and_providers_do_not_dedupe(self):
        self.cache({"one": {"p": "codex", "r": [self.row()], "t": []},
                    "two": {"p": "codex", "r": [self.row(session=1)], "t": []},
                    "claude": {"p": "claude", "r": [self.row(key="same")], "t": []}}, sessions=["a", "b"])
        snapshot = self.collector.snapshot()
        self.assertEqual(snapshot["providers"]["codex"]["records"], 2)
        self.assertEqual(snapshot["providers"]["claude"]["records"], 1)

    def test_unknown_rate_makes_whole_cost_unavailable_and_keeps_coverage(self):
        self.cache({"one": {"p": "codex", "r": [self.row(), self.row(model=1, session=1)], "t": []}},
                   models=["model-a", "unknown-model"], sessions=["a", "b"])
        self.rates()
        value = self.provider()
        self.assertEqual(value["total"], 200)
        self.assertIsNone(value["costUSD"])
        self.assertEqual(value["costKind"], "unavailable")
        self.assertEqual(value["unpricedRecords"], 1)
        self.assertAlmostEqual(value["knownCostUSD"], 1.295)
        self.assertIsNone(value["perModel"][1]["costUSD"])

    def test_reported_cost_including_zero_is_authoritative_without_prices(self):
        for cost in (0, 7.25):
            with self.subTest(cost=cost):
                self.cache({"one": {"p": "claude", "r": [self.row(cost=cost)], "t": []}})
                collector = usage.UsageCollector(self.home, lambda: self.now)
                value = collector.snapshot()["providers"]["claude"]
                self.assertEqual(value["costUSD"], cost)
                self.assertEqual(value["costKind"], "reported")

    def test_mixed_reported_and_estimated_cost_is_labelled_estimate(self):
        self.cache({"one": {"p": "claude", "r": [self.row(key="one", cost=5), self.row(key="two")], "t": []}})
        self.rates()
        value = self.provider("claude")
        self.assertAlmostEqual(value["costUSD"], 6.295)
        self.assertEqual((value["reportedRecords"], value["estimatedRecords"], value["costKind"]), (1, 1, "estimate"))

    def test_verified_rate_fallback_and_fast_multiplier(self):
        self.rates({"model-a": {"input_cost_per_token": .01, "output_cost_per_token": .02,
                                  "provider_specific_entry": {"fast": 2}}})
        self.cache({"one": {"p": "codex", "r": [self.row(speed=1)], "t": []}})
        self.assertAlmostEqual(self.provider()["costUSD"], 2.8)

    def test_ambiguous_qualified_rates_do_not_guess_alias(self):
        self.rates({"a/model-a": {"input_cost_per_token": .01, "output_cost_per_token": .02},
                    "b/model-a": {"input_cost_per_token": .02, "output_cost_per_token": .04}})
        self.cache()
        self.assertIsNone(self.provider()["costUSD"])

    def test_day_is_utc_and_previous_day_is_excluded(self):
        self.cache({"one": {"p": "codex", "r": [self.row(stamp=NOW - 86400), self.row()], "t": []}})
        snapshot = self.collector.snapshot()
        self.assertEqual(snapshot["scope"]["timeZone"], "UTC")
        self.assertEqual(snapshot["scope"]["day"], "2026-10-06")
        self.assertEqual(snapshot["providers"]["codex"]["total"], 100)

    def test_missing_corrupt_and_unknown_cache_are_unavailable_not_zero(self):
        for document in (None, "{broken", json.dumps({"version": 4, "models": [], "sessions": [], "files": {}})):
            with self.subTest(document=document):
                path = self.base / "usage-scan-cache-v5.json"
                if document is not None:
                    path.write_text(document)
                collector = usage.UsageCollector(self.home, lambda: self.now)
                value = collector.snapshot()["providers"]["codex"]
                self.assertIsNone(value["total"])
                self.assertIsNone(value["costUSD"])
                self.assertEqual(value["freshness"]["tokens"]["status"], "unavailable")

    def test_corrupt_refresh_retains_last_good_day_with_old_observation(self):
        self.cache()
        before = self.provider()
        (self.base / "usage-scan-cache-v5.json").write_text("broken")
        self.now += 61
        after = self.provider()
        self.assertEqual(after["total"], before["total"])
        self.assertEqual(after["freshness"]["tokens"]["observedAt"], before["freshness"]["tokens"]["observedAt"])
        self.assertTrue(after["freshness"]["tokens"]["stale"])
        self.now += 86400
        self.assertIsNone(self.provider()["total"])

    def test_invalid_row_and_resource_bounds_do_not_show_partial_totals(self):
        for bound, replacement in (("MAX_ROWS", 1), ("MAX_FILES", 0), ("MAX_JSON_BYTES", 10)):
            with self.subTest(bound=bound):
                self.cache({"one": {"p": "codex", "r": [self.row(), self.row()], "t": []}})
                with patch.object(usage, bound, replacement):
                    value = usage.UsageCollector(self.home, lambda: self.now).snapshot()["providers"]["codex"]
                self.assertIsNone(value["total"])
                self.assertTrue(value["errors"])
        self.cache({"one": {"p": "codex", "r": [self.row(tokens=(1, 2, 3, 4, 5))], "t": []}})
        self.assertIsNone(self.provider()["total"])

    def test_newest_quota_observation_wins_over_file_mtime_and_line_order(self):
        self.quota([self.event(42), self.event(99, NOW - 3600)], "one.jsonl")
        self.quota([self.event(1, NOW - 7200)], "recent-file.jsonl")
        self.quota([self.event(100)], "plus.jsonl", ".codex")
        value = self.provider()
        self.assertEqual(len(value["limits"]), 1)
        self.assertEqual(value["limits"][0]["usedPercent"], 42)
        self.assertEqual(value["limits"][0]["remainingPercent"], 58)
        self.assertEqual(value["limits"][0]["label"], "Weekly")

    def test_pro_session_window_is_not_published(self):
        self.quota([self.event(duration=300, secondary={"used_percent": 42, "window_minutes": 10080, "resets_at": NOW + 3600})])
        limits = self.provider()["limits"]
        self.assertEqual([limit["id"] for limit in limits], ["secondary"])

    def test_elapsed_reset_never_invents_available_quota_even_inside_cache(self):
        self.quota([self.event(100, reset=NOW + 30)])
        before = self.provider()["limits"][0]
        self.assertFalse(before["stale"])
        self.now += 31
        snapshot = self.collector.snapshot()
        after = snapshot["providers"]["codex"]["limits"][0]
        self.assertTrue(snapshot["cached"])
        self.assertTrue(after["stale"])
        self.assertEqual(after["usedPercent"], 100)
        self.assertEqual(after["remainingPercent"], 0)

    def test_limit_is_stale_by_observation_not_refresh_time(self):
        self.quota([self.event(42, NOW - 3600)])
        value = self.provider()
        self.assertTrue(value["limits"][0]["stale"])
        self.assertEqual(value["limits"][0]["observedAt"], usage._iso(NOW - 3600))

    def test_source_error_retains_last_quota_and_marks_it_stale(self):
        path = self.quota()
        self.assertFalse(self.provider()["limits"][0]["stale"])
        path.unlink()
        self.now += 61
        with patch.object(usage, "MAX_SCAN_ENTRIES", 0):
            after = self.provider()
        self.assertEqual(after["limits"][0]["usedPercent"], 42)
        self.assertTrue(after["limits"][0]["stale"])

    def test_incremental_scan_only_reads_changed_files_and_keeps_incomplete_line(self):
        path = self.quota()
        self.assertEqual(self.provider()["limits"][0]["usedPercent"], 42)
        self.now += 61
        with patch.object(Path, "open", autospec=True, wraps=Path.open) as opened:
            # JSON caches are missing; an unchanged quota file must not be opened.
            self.provider()
            self.assertFalse(any(call.args[0] == path for call in opened.call_args_list))
        encoded = json.dumps(self.event(43, self.now))
        with path.open("a") as handle:
            handle.write(encoded[:len(encoded) // 2])
        self.now += 61
        self.assertEqual(self.provider()["limits"][0]["usedPercent"], 42)
        with path.open("a") as handle:
            handle.write(encoded[len(encoded) // 2:] + "\n")
        self.now += 61
        self.assertEqual(self.provider()["limits"][0]["usedPercent"], 43)

    def test_quota_tail_line_and_file_limits(self):
        path = self.quota()
        path.write_text("x" * 1000 + "\n" + json.dumps(self.event()) + "\n")
        with patch.object(usage, "MAX_TAIL_BYTES", 512), patch.object(usage, "MAX_LINE_BYTES", 32):
            value = self.provider()
        self.assertEqual(value["limits"], [])
        self.assertIn("codex_quota_line_bound_reached", value["errors"])
        self.now += 61
        with patch.object(usage, "MAX_QUOTA_FILES", 0):
            self.assertEqual(self.provider()["limits"], [])

    def test_rewritten_larger_quota_file_invalidates_incremental_position(self):
        path = self.quota()
        self.assertEqual(self.provider()["limits"][0]["usedPercent"], 42)
        self.now += 61
        path.write_text(json.dumps(self.event(43, self.now)) + "\n" + "x" * 400 + "\n")
        self.assertEqual(self.provider()["limits"][0]["usedPercent"], 43)

    def test_scan_directory_and_byte_budgets_are_reported(self):
        self.quota()
        with patch.object(usage, "MAX_SCAN_ENTRIES", 0):
            self.assertIn("codex_quota_directory_bound_reached", self.provider()["errors"])
        self.now += 61
        with patch.object(usage, "MAX_SCAN_BYTES", 0):
            self.assertIn("codex_quota_byte_bound_reached", self.provider()["errors"])

    def test_notice_exhaustion_is_read_only_sanitized_and_not_live(self):
        path = self.notices()
        original = path.read_bytes()
        value = self.provider("claude")
        limit = value["limits"][0]
        self.assertEqual(limit["usedPercent"], 100)
        self.assertEqual(limit["resetsAt"], usage._iso(NOW + 205 * 60))
        self.assertEqual(limit["resetKind"], "notice_relative_estimate")
        self.assertEqual(path.read_bytes(), original)
        self.now += 205 * 60 + 1
        after = self.provider("claude")["limits"][0]
        self.assertTrue(after["stale"])
        self.assertEqual(after["usedPercent"], 100)

    def test_newest_notice_and_exact_message_grammar_avoid_false_limits(self):
        message = "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 3h 25m."
        self.notices([("system_notice", NOW - 60, {"message": message}),
                      ("system_notice", NOW, {"message": message}),
                      ("assistant", NOW + 1, {"message": message}),
                      ("system_notice", NOW + 2, {"message": "secret prompt: " + message})])
        value = self.provider("claude")
        self.assertEqual(value["limits"][0]["observedAt"], usage._iso(NOW))
        self.assertNotIn("secret", json.dumps(self.collector.snapshot()))

    def test_notice_updates_do_not_refresh_the_actual_observation(self):
        message = "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 3h 25m."
        self.notices([("system_notice", NOW, {"message": message, "startedAt": usage._iso(NOW - 3600)})])
        limit = self.provider("claude")["limits"][0]
        self.assertEqual(limit["observedAt"], usage._iso(NOW - 3600))
        self.assertTrue(limit["stale"])

    def test_oversized_notice_and_invalid_database_are_unavailable(self):
        self.notices([("system_notice", NOW, {"message": "Claude usage limit reached" + "x" * 20_000})])
        self.assertEqual(self.provider("claude")["limits"], [])
        (self.base / "statev2.sqlite").write_bytes(b"corrupt")
        self.now += 61
        self.assertIn("claude_notice_database_unavailable", self.provider("claude")["errors"])

    def test_future_quota_and_invalid_percent_are_not_accepted(self):
        self.quota([self.event(99, NOW + 60), self.event(101)])
        self.assertEqual(self.provider()["limits"], [])
        self.now += 61
        self.assertEqual(self.provider()["limits"][0]["usedPercent"], 99)

    def test_root_storage_uses_available_free_and_used_over_total(self):
        disk = type("Disk", (), {"total": 100 * 1024**3, "used": 40 * 1024**3, "free": 55 * 1024**3})()
        with patch.object(usage.shutil, "disk_usage", return_value=disk) as read:
            storage = self.collector.snapshot()["storage"]
        read.assert_called_once_with("/")
        self.assertEqual((storage["totalGiB"], storage["usedGiB"], storage["freeGiB"], storage["usedPercent"]), (100, 40, 55, 40))
        self.assertEqual(storage["freeKind"], "available_to_unprivileged_process")

    def test_storage_failure_has_null_values(self):
        with patch.object(usage.shutil, "disk_usage", side_effect=OSError):
            storage = self.collector.snapshot()["storage"]
        self.assertIsNone(storage["usedPercent"])
        self.assertTrue(storage["stale"])

    def test_cache_is_thread_safe_detached_json_safe_and_refreshes_at_sixty_seconds(self):
        self.cache()
        self.rates()
        with patch.object(usage.shutil, "disk_usage", wraps=usage.shutil.disk_usage) as read:
            values = []
            workers = [threading.Thread(target=lambda: values.append(self.collector.snapshot())) for _ in range(8)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join()
            self.assertEqual(len(values), 8)
            self.assertEqual(read.call_count, 1)
            self.assertEqual(self.mounted_calls, ["/", "/mnt/games"])
            self.assertEqual(sum(not value["cached"] for value in values), 1)
            values[0]["providers"]["codex"]["total"] = -1
            values[0]["mountedStorage"]["mounts"][0]["aliases"].append("/fake")
            values[0]["mountedStorage"]["mounts"][1]["freeGiB"] = -1
            self.assertEqual(self.provider()["total"], 100)
            self.assertEqual(self.collector.snapshot()["mountedStorage"]["mounts"][0]["aliases"], ["/home"])
            self.assertEqual(self.collector.snapshot()["mountedStorage"]["mounts"][1]["freeGiB"], 55)
            self.now += 59
            cached = self.collector.snapshot()
            self.assertTrue(cached["cached"])
            self.assertEqual(cached["mountedStorage"]["observedAt"], usage._iso(NOW))
            self.assertEqual(self.mounted_calls, ["/", "/mnt/games"])
            self.mountinfo.write_text("1 0 8:1 / / rw - btrfs /dev/root rw\n")
            self.now += 1
            refreshed = self.collector.snapshot()
            self.assertEqual(read.call_count, 2)
            self.assertEqual(self.mounted_calls, ["/", "/mnt/games", "/"])
            self.assertEqual([row["mount"] for row in refreshed["mountedStorage"]["mounts"]], ["/"])
            self.assertEqual(refreshed["mountedStorage"]["mounts"][0]["aliases"], [])
        json.dumps(self.collector.snapshot(), allow_nan=False)


if __name__ == "__main__":
    unittest.main()
