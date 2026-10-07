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

    def test_explicit_reported_five_hour_window_overrides_pro_default(self):
        self.quota([self.event(duration=300, secondary={"used_percent": 42, "window_minutes": 10080, "resets_at": NOW + 3600})])
        limits = self.provider()["limits"]
        self.assertEqual([limit["id"] for limit in limits], ["primary", "secondary"])

    def test_newest_quota_timestamp_wins_across_chunks_cold_cached_and_unchanged(self):
        tool = {"timestamp": usage._iso(NOW), "type": "response_item",
                "payload": {"type": "function_call_output", "output": "x" * (384 * 1024)}}
        path = self.quota([self.event(54), tool, self.event(99, NOW - 3600)])
        for elapsed in (0, 1, 61):
            with self.subTest(elapsed=elapsed):
                self.now = NOW + elapsed
                if elapsed:
                    with patch.object(Path, "open", autospec=True, wraps=Path.open) as opened:
                        value = self.provider()
                        self.assertFalse(any(call.args[0] == path for call in opened.call_args_list))
                else:
                    value = self.provider()
                self.assertEqual(value["limits"][0]["usedPercent"], 54)
                self.assertEqual(value["limits"][0]["observedAt"], usage._iso(NOW))
                self.assertFalse(value["limits"][0]["stale"])
                self.assertEqual(value["freshness"]["limits"]["errors"], [])

    def test_newest_quota_timestamp_wins_across_chunks_incremental(self):
        path = self.quota()
        self.provider()
        self.now += 61
        tool = {"timestamp": usage._iso(self.now), "type": "response_item",
                "payload": {"type": "function_call_output", "output": "x" * (384 * 1024)}}
        with path.open("a") as handle:
            for event in (self.event(54, self.now), tool, self.event(99, NOW - 3600)):
                handle.write(json.dumps(event) + "\n")
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 54)
        self.assertEqual(value["limits"][0]["observedAt"], usage._iso(self.now))
        self.assertFalse(value["limits"][0]["stale"])
        self.assertEqual(value["freshness"]["limits"]["errors"], [])

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

    def test_fresh_quota_before_huge_tool_output_is_found_without_false_staleness(self):
        path = self.quota()
        self.assertEqual(self.provider()["limits"][0]["usedPercent"], 42)
        self.now += 61
        tool = {"timestamp": usage._iso(self.now), "type": "response_item",
                "payload": {"type": "function_call_output", "output": "x" * (384 * 1024)}}
        with path.open("a") as handle:
            handle.write(json.dumps(self.event(54, self.now)) + "\n" + json.dumps(tool) + "\n")
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 54)
        self.assertFalse(value["limits"][0]["stale"])
        self.assertEqual(value["freshness"]["limits"]["errors"], [])

    def test_cold_scan_skips_huge_irrelevant_envelopes_with_live_ordinal_field(self):
        events = [self.event(54)]
        for outer, inner in (("response_item", "function_call_output"),
                             ("event_msg", "user_message"), ("turn_context", "context")):
            events.append({"timestamp": usage._iso(NOW), "ordinal": len(events), "type": outer,
                           "payload": {"type": inner, "rate_limits": "not telemetry",
                                       "text": "private" * (24 * 1024)}})
        self.quota(events)
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 54)
        self.assertFalse(value["limits"][0]["stale"])
        self.assertEqual(value["freshness"]["limits"]["errors"], [])
        self.assertNotIn("private", json.dumps(value))

    def test_huge_quota_and_malformed_quota_remain_stale_until_new_telemetry(self):
        oversized = self.event(54)
        oversized["payload"]["info"] = "x" * (usage.MAX_LINE_BYTES + 1)
        malformed = json.dumps(self.event(54))[:-2] + "\n"
        for bad, error in ((json.dumps(oversized) + "\n", "codex_quota_line_bound_reached"),
                           (malformed, "codex_quota_invalid_event"),
                           (json.dumps(self.event(101)) + "\n", "codex_quota_invalid_event")):
            with self.subTest(error=error, size=len(bad)):
                self.now = NOW
                self.collector = usage.UsageCollector(self.home, lambda: self.now,
                                                       mountinfo_path=self.mountinfo)
                path = self.quota()
                self.provider()
                with path.open("a") as handle:
                    handle.write(bad)
                self.now += 61
                value = self.provider()
                self.assertEqual(value["limits"][0]["usedPercent"], 42)
                self.assertTrue(value["limits"][0]["stale"])
                self.assertIn(error, value["freshness"]["limits"]["errors"])
                self.now += 61
                self.assertIn(error, self.provider()["freshness"]["limits"]["errors"])
                with path.open("a") as handle:
                    handle.write('{"type":"response_item","payload":{}}\n')
                self.now += 61
                self.assertIn(error, self.provider()["freshness"]["limits"]["errors"])
                with path.open("a") as handle:
                    handle.write(json.dumps(self.event(41, NOW - 61)) + "\n")
                self.now += 61
                value = self.provider()
                self.assertEqual(value["limits"][0]["usedPercent"], 42)
                self.assertIn(error, value["freshness"]["limits"]["errors"])
                with path.open("a") as handle:
                    handle.write(json.dumps(self.event(55, self.now)) + "\n")
                self.now += 61
                value = self.provider()
                self.assertEqual(value["limits"][0]["usedPercent"], 55)
                self.assertFalse(value["limits"][0]["stale"])
                self.assertEqual(value["freshness"]["limits"]["errors"], [])

    def test_partial_real_quota_is_incomplete_then_becomes_fresh_on_completion(self):
        path = self.quota()
        self.provider()
        self.now += 61
        event = json.dumps(self.event(54, self.now))
        with path.open("a") as handle:
            handle.write(event[:-8])
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 42)
        self.assertIn("codex_quota_incomplete_event", value["freshness"]["limits"]["errors"])
        self.assertTrue(value["limits"][0]["stale"])
        with path.open("a") as handle:
            handle.write(event[-8:] + "\n")
        self.now += 61
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 54)
        self.assertFalse(value["limits"][0]["stale"])

    def test_partial_huge_tool_row_then_completion_and_rotation_preserve_quota(self):
        path = self.quota()
        self.provider()
        self.now += 61
        tool = json.dumps({"timestamp": usage._iso(self.now), "ordinal": 2, "type": "response_item",
                           "payload": {"type": "function_call_output", "output": "x" * (384 * 1024)}})
        with path.open("a") as handle:
            handle.write(json.dumps(self.event(54, self.now)) + "\n" + tool[:-10])
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 54)
        self.assertFalse(value["limits"][0]["stale"])
        self.now += 61
        with path.open("a") as handle:
            handle.write(tool[-10:] + "\n" + json.dumps(self.event(55, self.now)) + "\n")
        self.assertEqual(self.provider()["limits"][0]["usedPercent"], 55)
        self.now += 61
        replacement = path.with_suffix(".replacement")
        replacement.write_text(json.dumps(self.event(56, self.now)) + "\n" + tool + "\n")
        replacement.replace(path)
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 56)
        self.assertFalse(value["limits"][0]["stale"])

    def test_backward_chunks_reconstruct_quota_at_every_boundary(self):
        for padding in (0, 1, 127, 128, 129, 255):
            with self.subTest(padding=padding):
                self.quota([self.event(54), {"timestamp": usage._iso(NOW), "type": "response_item",
                                           "payload": {"type": "function_call_output", "output": "x" * padding}}])
                collector = usage.UsageCollector(self.home, lambda: self.now, mountinfo_path=self.mountinfo)
                with patch.object(usage, "QUOTA_CHUNK_BYTES", 128):
                    value = collector.snapshot()["providers"]["codex"]
                self.assertEqual(value["limits"][0]["usedPercent"], 54)
                self.assertFalse(value["limits"][0]["stale"])

    def test_supported_quota_in_bounded_tail_does_not_require_entire_history(self):
        tool = {"timestamp": usage._iso(NOW), "type": "response_item",
                "payload": {"type": "function_call_output", "output": "x" * (usage.MAX_TAIL_BYTES + 100)}}
        self.quota([tool, self.event(54)])
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 54)
        self.assertFalse(value["limits"][0]["stale"])
        self.assertEqual(value["freshness"]["limits"]["errors"], [])

    def test_total_budget_before_other_candidates_keeps_supported_quota_stale(self):
        tool = {"timestamp": usage._iso(NOW), "type": "response_item",
                "payload": {"type": "function_call_output", "output": "x" * (usage.MAX_TAIL_BYTES + 100)}}
        for i in range(3):
            self.quota([tool, self.event(54)], name=f"{i}.jsonl")
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 54)
        self.assertTrue(value["limits"][0]["stale"])
        self.assertEqual(value["freshness"]["limits"]["errors"], ["codex_quota_byte_bound_reached"])

    def test_supported_quota_does_not_hide_invalid_record_in_earlier_chunk(self):
        tool = {"timestamp": usage._iso(NOW), "type": "response_item",
                "payload": {"type": "function_call_output", "output": "x" * (384 * 1024)}}
        self.quota([self.event(101), tool, self.event(54)])
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 54)
        self.assertTrue(value["limits"][0]["stale"])
        self.assertEqual(value["freshness"]["limits"]["errors"], ["codex_quota_invalid_event"])

    def test_per_file_and_total_read_budgets_include_guard_reads(self):
        paths = []
        for i in range(3):
            path = self.quota(name=f"{i}.jsonl")
            with path.open("a") as handle:
                handle.write("x" * (usage.MAX_TAIL_BYTES + 100) + "\n")
            paths.append(path)
        original_open = Path.open
        reads = {path: 0 for path in paths}

        class TrackedFile:
            def __init__(self, handle, path):
                self.handle, self.path = handle, path

            def __getattr__(self, name):
                return getattr(self.handle, name)

            def read(self, count):
                self.assert_bounded(count)
                data = self.handle.read(count)
                reads[self.path] += len(data)
                return data

            @staticmethod
            def assert_bounded(count):
                if not 0 <= count <= usage.QUOTA_CHUNK_BYTES:
                    raise AssertionError("unbounded read")

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.handle.close()

        def tracked_open(path, *args, **kwargs):
            handle = original_open(path, *args, **kwargs)
            return TrackedFile(handle, path) if path in reads else handle

        with patch.object(Path, "open", tracked_open):
            errors = self.collector._codex_limits(self.now)
        self.assertIn("codex_quota_byte_bound_reached", errors)
        self.assertLessEqual(sum(reads.values()), usage.MAX_SCAN_BYTES)
        self.assertTrue(all(count <= usage.MAX_TAIL_BYTES for count in reads.values()))

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

    def period(self):
        return self.collector.snapshot()["periods"]["last30days"]

    def provider_cache(self, provider="codex", windows=None, *, stamp=NOW, unavailable=None, **overrides):
        instance, driver = ("codex-pro", "codex") if provider == "codex" else ("claudeAgent", "claudeAgent")
        document = {"instanceId": instance, "driver": driver, "enabled": True, "installed": True,
                    "status": "ready", "checkedAt": usage._iso(stamp),
                    "usageLimits": {"checkedAt": usage._iso(stamp), "windows": windows or []}}
        if unavailable is not None:
            document["usageLimits"]["unavailable"] = {"reason": unavailable}
        document.update(overrides)
        root = self.home / ".t3/caches"
        root.mkdir(parents=True, exist_ok=True)
        path = root / (instance + ".json")
        path.write_text(json.dumps(document))
        return path

    @staticmethod
    def window(key="primary", duration=10080, used=0, reset=NOW + 3600, kind="weekly"):
        return {"id": key, "kind": kind, "label": "Weekly" if kind == "weekly" else "Session",
                "usedPercent": used, "windowDurationMins": duration, "resetsAt": usage._iso(reset)}

    def test_rolling_boundary_future_exclusion_daily_unchanged_single_decode_and_price(self):
        start = NOW - usage.LAST30_SECONDS
        self.cache({"one": {"p": "codex", "r": [self.row(stamp=start - .001), self.row(stamp=start),
                    self.row(stamp=NOW - 86400), self.row(), self.row(stamp=NOW + .001)], "t": []}})
        self.rates()
        with patch.object(usage, "_read_json", wraps=usage._read_json) as read, \
                patch.object(usage, "_decode_row", wraps=usage._decode_row) as decode, \
                patch.object(usage, "_price", wraps=usage._price) as price:
            snapshot = self.collector.snapshot()
        self.assertEqual(decode.call_count, 5)
        self.assertEqual(price.call_count, 3)
        self.assertEqual(sum(call.args[0].name == "usage-scan-cache-v5.json" for call in read.call_args_list), 1)
        self.assertEqual(snapshot["providers"]["codex"]["total"], 100)
        self.assertEqual(set(snapshot["providers"]), {"codex", "claude"})
        period = snapshot["periods"]["last30days"]
        self.assertEqual((period["scope"]["startsAt"], period["scope"]["endsAt"], period["scope"]["timeZone"]),
                         (usage._iso(start), usage._iso(NOW), "UTC"))
        self.assertEqual(period["providers"]["codex"]["total"], 300)
        self.assertEqual(period["providers"]["codex"]["records"], 3)
        self.assertAlmostEqual(period["providers"]["codex"]["costUSD"], 3 * 1.295)
        self.assertIsNone(period["providers"]["cursor"]["total"])
        self.assertIsNone(period["providers"]["cursor"]["knownCostUSD"])

    def test_rolling_cursor_provider_attribution_dedup_and_partial_pricing(self):
        row = self.row(key="cursor-one", cost=0, stamp=NOW - 86400)
        unknown = self.row(model=1, key="cursor-two")
        self.cache({"one": {"p": "cursor", "r": [row], "t": [unknown]},
                    "copy": {"p": "cursor", "r": [row], "t": [unknown]},
                    "claude": {"p": "claude", "r": [self.row(key="cursor-one", cost=5)], "t": []}},
                   models=["claude-through-cursor", "unknown"])
        value = self.period()["providers"]["cursor"]
        self.assertEqual((value["total"], value["records"], value["duplicatesDropped"]), (200, 2, 2))
        self.assertEqual((value["knownCostUSD"], value["reportedRecords"], value["unpricedRecords"]), (0, 1, 1))
        self.assertIsNone(value["costUSD"])
        self.assertEqual(value["costKind"], "unavailable")
        self.assertEqual(self.period()["providers"]["claude"]["total"], 100)

    def test_rolling_copied_codex_occurrences_and_claude_share_daily_dedup(self):
        rows = [self.row(stamp=NOW - 86400), self.row(), self.row()]
        self.cache({"one": {"p": "codex", "r": rows, "t": []},
                    "copy": {"p": "codex", "r": rows, "t": []}})
        snapshot = self.collector.snapshot()
        daily = snapshot["providers"]["codex"]
        rolling = snapshot["periods"]["last30days"]["providers"]["codex"]
        self.assertEqual((daily["records"], rolling["records"]), (2, 3))
        self.assertEqual((daily["duplicatesDropped"], rolling["duplicatesDropped"]), (3, 3))

    def test_rolling_refresh_expires_records_even_when_file_unchanged(self):
        self.cache({"one": {"p": "codex", "r": [self.row(stamp=NOW - usage.LAST30_SECONDS + 30)], "t": []}})
        before = self.period()
        self.assertEqual(before["providers"]["codex"]["total"], 100)
        self.now += 59
        self.assertEqual(self.period()["scope"], before["scope"])
        self.now += 1
        after = self.period()
        self.assertEqual(after["providers"]["codex"]["total"], 0)
        self.assertIsNone(after["providers"]["codex"]["costUSD"])
        self.assertEqual(after["providers"]["codex"]["endsAt"], usage._iso(self.now))
        self.assertNotIn("observedScope", after["providers"]["codex"])

    def test_rolling_corrupt_retention_keeps_original_bounds_across_shift_and_rollback(self):
        self.cache()
        before = self.period()
        (self.base / "usage-scan-cache-v5.json").write_text("corrupt")
        for now in (NOW + 61, NOW + 86400, NOW - 100):
            with self.subTest(now=now):
                self.now = now
                after = self.period()
                value = after["providers"]["codex"]
                self.assertEqual(value["total"], 100)
                self.assertEqual(value["observedScope"], before["scope"])
                self.assertEqual(value["startsAt"], before["scope"]["startsAt"])
                self.assertEqual(value["endsAt"], usage._iso(NOW))
                self.assertEqual(after["scope"]["endsAt"], usage._iso(now))
                self.assertTrue(value["freshness"]["tokens"]["stale"])
                self.assertEqual(value["freshness"]["tokens"]["observedAt"], before["providers"]["codex"]["freshness"]["tokens"]["observedAt"])

    def test_rolling_clock_rollback_refolds_future_records_and_snapshot_is_detached(self):
        self.cache()
        self.assertEqual(self.period()["providers"]["codex"]["total"], 100)
        self.now -= 10
        period = self.period()
        self.assertEqual(period["providers"]["codex"]["total"], 0)
        period["scope"]["endsAt"] = "changed"
        period["providers"]["codex"]["total"] = -1
        self.assertEqual(self.period()["providers"]["codex"]["total"], 0)
        self.assertEqual(self.period()["scope"]["endsAt"], usage._iso(self.now))

    def test_rolling_bounds_and_invalid_old_rows_reject_entire_scan(self):
        for bound, replacement in (("MAX_ROWS", 1), ("MAX_FILES", 0), ("MAX_JSON_BYTES", 10),
                                   ("MAX_MODELS", 0), ("MAX_SESSIONS", 0)):
            with self.subTest(bound=bound):
                self.cache({"one": {"p": "cursor", "r": [self.row(), self.row()], "t": []}})
                with patch.object(usage, bound, replacement):
                    snapshot = usage.UsageCollector(self.home, lambda: self.now).snapshot()
                self.assertIsNone(snapshot["periods"]["last30days"]["providers"]["cursor"]["total"])
        self.cache({"one": {"p": "codex", "r": [self.row(), self.row(tokens=(1, 2, 3, 4, 5), stamp=NOW - usage.LAST30_SECONDS - 1)], "t": []}})
        self.assertIsNone(self.period()["providers"]["codex"]["total"])

    def test_pro_account_has_no_five_hour_even_when_evidence_expires(self):
        self.quota()
        self.assertEqual(self.provider()["quotaWindows"], {"five_hour": "unsupported", "weekly": "supported"})
        self.now = NOW + usage.STALE_SECONDS - 10
        self.assertEqual(self.provider()["quotaWindows"]["five_hour"], "unsupported")
        self.now += 11
        self.assertTrue(self.collector.snapshot()["cached"])
        self.assertEqual(self.provider()["quotaWindows"]["five_hour"], "unsupported")
        self.assertEqual(self.provider()["limits"][0]["usedPercent"], 42)

    def test_missing_incomplete_invalid_and_source_failure_do_not_prove_inapplicable(self):
        event = self.event()
        del event["payload"]["rate_limits"]["secondary"]
        path = self.quota([event])
        self.assertEqual(self.provider()["quotaWindows"]["five_hour"], "unsupported")
        self.now += 61
        path.write_text(json.dumps(self.event(stamp=self.now)) + "\n")
        self.assertEqual(self.provider()["quotaWindows"]["five_hour"], "unsupported")
        self.now += 61
        with path.open("a") as handle:
            handle.write(json.dumps(self.event(101, self.now)) + "\n")
        self.assertEqual(self.provider()["quotaWindows"]["five_hour"], "unsupported")
        self.assertTrue(self.provider()["limits"][0]["stale"])

    def test_structured_pro_weekly_and_claude_actual_windows_without_fallback_reads(self):
        self.provider_cache(windows=[self.window()])
        self.provider_cache("claude", [self.window("five_hour", 300, 10, kind="session"),
                                       self.window("seven_day", used=45)])
        with patch.object(self.collector, "_codex_limits", side_effect=AssertionError("unexpected scan")), \
                patch.object(self.collector, "_claude_limits", side_effect=AssertionError("unexpected database")):
            snapshot = self.collector.snapshot()
        codex, claude = snapshot["providers"]["codex"], snapshot["providers"]["claude"]
        self.assertEqual(codex["quotaWindows"], {"five_hour": "unsupported", "weekly": "supported"})
        self.assertEqual(codex["limits"][0]["usedPercent"], 0)
        self.assertFalse(codex["limits"][0]["stale"])
        self.assertEqual(claude["quotaWindows"], {"five_hour": "supported", "weekly": "supported"})
        self.assertEqual([limit["usedPercent"] for limit in claude["limits"]], [10, 45])
        self.assertTrue(all(limit["source"] == "t3_provider_usage_limits" for limit in claude["limits"]))
        self.assertTrue(all(not limit["stale"] for limit in claude["limits"]))

    def test_newest_first_sparse_transcript_keeps_actual_session_but_full_inventory_wins(self):
        older = self.event(stamp=NOW - 60, duration=300,
                           secondary={'used_percent': 40, 'window_minutes': 10080})
        newer = self.event(stamp=NOW)
        del newer['payload']['rate_limits']['secondary']
        path = self.quota([older, newer])
        self.assertEqual(self.provider()['quotaWindows']['five_hour'], 'supported')
        self.now += 61
        path.write_text(json.dumps(older) + '\n' + json.dumps(self.event(stamp=self.now)) + '\n')
        self.assertEqual(self.provider()['quotaWindows']['five_hour'], 'unsupported')

    def test_sparse_weekly_cannot_refresh_old_unsupported_claude_session(self):
        self.provider_cache('claude', unavailable='unsupported')
        self.assertEqual(self.provider('claude')['quotaWindows']['five_hour'], 'unsupported')
        self.now += usage.STALE_SECONDS + 1
        self.provider_cache('claude', [self.window('seven_day', used=40)], stamp=self.now)
        windows = self.provider('claude')['quotaWindows']
        self.assertEqual(windows, {'five_hour': 'unknown', 'weekly': 'supported'})

    def test_structured_actual_session_survives_sparse_refresh_and_idle(self):
        self.provider_cache(windows=[self.window('primary', 300, 20, kind='session'), self.window('secondary', used=40)])
        value = self.provider()
        self.assertEqual(value['quotaWindows']['five_hour'], 'supported')
        self.assertEqual([limit['windowMinutes'] for limit in value['limits']], [300, 10080])
        self.now += 61
        self.provider_cache(windows=[self.window('secondary', used=41)], stamp=self.now,
                            checkedAt=usage._iso(self.now - 5))
        self.assertEqual(self.provider()['quotaWindows']['five_hour'], 'supported')
        self.now += usage.STALE_SECONDS + 1
        self.assertEqual(self.provider()['quotaWindows']['five_hour'], 'supported')
        self.assertTrue(self.provider()['limits'][0]['stale'])

    def test_pro_five_hour_stays_inapplicable_across_sparse_idle_and_failed_refresh(self):
        self.provider_cache(windows=[self.window()], checkedAt=usage._iso(NOW - 60))
        self.assertEqual(self.provider()['quotaWindows']['five_hour'], 'unsupported')
        self.now += usage.STALE_SECONDS + 1
        self.assertEqual(self.provider()['quotaWindows']['five_hour'], 'unsupported')
        self.provider_cache(unavailable='probeFailed', stamp=self.now)
        self.now += 61
        self.assertEqual(self.provider()['quotaWindows']['five_hour'], 'unsupported')
        self.assertTrue(self.provider()['limits'][0]['stale'])

    def test_structured_failure_retains_stale_windows_never_zeros_or_unsupported(self):
        self.provider_cache(windows=[self.window(used=42)])
        self.assertEqual(self.provider()["quotaWindows"]["five_hour"], "unsupported")
        self.now += 61
        self.provider_cache(windows=[], stamp=self.now, unavailable="probeFailed")
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 42)
        self.assertTrue(value["limits"][0]["stale"])
        self.assertEqual(value["quotaWindows"]["five_hour"], "unsupported")
        self.assertIn("provider_quota_probe_failed", value["errors"])

    def test_structured_claude_sparse_unknown_weekly_and_notice_fallback_is_stale(self):
        self.notices()
        fallback = self.provider("claude")
        self.assertEqual(fallback["quotaWindows"], {"five_hour": "supported", "weekly": "unknown"})
        self.assertTrue(fallback["limits"][0]["stale"])
        self.assertEqual(fallback["limits"][0]["resetKind"], "notice_relative_estimate")
        self.now += 61
        self.provider_cache("claude", [self.window("five_hour", 300, 10, kind="session"), self.window("seven_day", used=45)], stamp=self.now)
        self.provider("claude")
        self.now += 61
        self.provider_cache("claude", [self.window("five_hour", 300, 11, kind="session")], stamp=self.now)
        value = self.provider("claude")
        self.assertEqual(len(value["limits"]), 2)
        weekly = next(limit for limit in value["limits"] if limit["id"] == "seven_day")
        self.assertEqual(weekly["usedPercent"], 45)
        self.assertEqual(weekly["observedAt"], usage._iso(self.now - 61))
        self.assertEqual(value["quotaWindows"]["weekly"], "supported")

    def test_structured_unsupported_reporting_expires_and_does_not_use_notice(self):
        self.notices()
        self.provider_cache("claude", unavailable="unsupported")
        with patch.object(self.collector, "_claude_limits", side_effect=AssertionError("unexpected fallback")):
            value = self.provider("claude")
        self.assertEqual(value["limits"], [])
        self.assertEqual(value["quotaWindows"], {"five_hour": "unsupported", "weekly": "unsupported"})
        self.now += usage.STALE_SECONDS + 1
        self.assertEqual(self.provider("claude")["quotaWindows"]["weekly"], "unknown")

    def test_structured_identity_bounds_invalid_values_and_future_data_are_unknown(self):
        variants = [{"instanceId": "codex"}, {"driver": "claudeAgent"}, {"status": "failed"}]
        for override in variants:
            with self.subTest(override=override):
                self.provider_cache(windows=[self.window()], **override)
                snapshot = usage.UsageCollector(self.home, lambda: self.now).snapshot()
                self.assertEqual(snapshot["providers"]["codex"]["quotaWindows"]["five_hour"], "unsupported")
        for window in (self.window(used=101), self.window(duration=-1), self.window(key="x" * 129)):
            self.provider_cache(windows=[window])
            value = usage.UsageCollector(self.home, lambda: self.now).snapshot()["providers"]["codex"]
            self.assertEqual(value["limits"], [])
            self.assertEqual(value["quotaWindows"]["five_hour"], "unsupported")
        self.provider_cache(windows=[self.window()], stamp=self.now + 60)
        self.assertEqual(self.provider()["quotaWindows"]["five_hour"], "unsupported")
        self.provider_cache(windows=[self.window()])
        for bound in ("MAX_PROVIDER_BYTES", "MAX_WINDOWS"):
            with patch.object(usage, bound, 0):
                value = usage.UsageCollector(self.home, lambda: self.now).snapshot()["providers"]["codex"]
            self.assertEqual(value["limits"], [])
            self.assertIn("unknown", value["quotaWindows"].values())

    def test_structured_quota_expiry_changes_inside_cache_without_invented_reset(self):
        self.provider_cache(windows=[self.window(used=100, reset=NOW + 20)])
        value = self.provider()
        self.assertFalse(value["limits"][0]["stale"])
        self.now += 21
        snapshot = self.collector.snapshot()
        value = snapshot["providers"]["codex"]
        self.assertTrue(snapshot["cached"])
        self.assertTrue(value["limits"][0]["stale"])
        self.assertEqual((value["limits"][0]["usedPercent"], value["limits"][0]["remainingPercent"]), (100, 0))
        self.now = NOW + usage.STALE_SECONDS - 10
        self.provider()
        self.now += 11
        self.assertTrue(self.collector.snapshot()["cached"])
        self.assertEqual(self.provider()["quotaWindows"]["five_hour"], "unsupported")

    def test_structured_older_snapshot_does_not_replace_fresher_fallback(self):
        self.quota([self.event(54)])
        self.assertEqual(self.provider()["limits"][0]["usedPercent"], 54)
        self.now += 61
        self.provider_cache(windows=[self.window(used=99)], stamp=NOW - 60)
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 54)
        self.assertEqual(value["limits"][0]["observedAt"], usage._iso(NOW))
        self.now = NOW + 400
        self.quota([self.event(55, stamp=self.now)])
        value = self.provider()
        self.assertEqual(value["limits"][0]["usedPercent"], 55)
        self.assertFalse(value["limits"][0]["stale"])

    def test_structured_window_retention_is_bounded_and_invalid_snapshot_is_atomic(self):
        self.provider_cache("claude", [self.window("seven_day", used=45)])
        self.assertEqual(self.provider("claude")["limits"][0]["usedPercent"], 45)
        self.now += 61
        self.provider_cache("claude", [self.window("seven_day", used=46), self.window("invalid", used=101)], stamp=self.now)
        value = self.provider("claude")
        self.assertEqual(len(value["limits"]), 1)
        self.assertEqual(value["limits"][0]["usedPercent"], 45)
        self.assertTrue(value["limits"][0]["stale"])
        self.now += 61
        self.provider_cache("claude", [self.window("new-window", used=47)], stamp=self.now)
        with patch.object(usage, "MAX_WINDOWS", 1):
            value = self.provider("claude")
        self.assertEqual(len(value["limits"]), 1)
        self.assertIn("provider_quota_cache_invalid", value["errors"])

    def test_failed_auth_empty_inventory_and_atomic_event_cannot_prove_unsupported(self):
        self.provider_cache(unavailable="unsupported", status="failed")
        self.assertEqual(self.provider()["quotaWindows"]["five_hour"], "unsupported")
        self.now += 61
        self.provider_cache(windows=[])
        value = self.provider()
        self.assertEqual(value["quotaWindows"]["five_hour"], "unsupported")
        self.assertIn("provider_quota_windows_unavailable", value["errors"])
        self.now += 61
        (self.home / ".t3/caches/codex-pro.json").unlink()
        self.quota([self.event(54, stamp=self.now, secondary={"used_percent": 101, "window_minutes": 10080})])
        value = self.provider()
        self.assertEqual(value["limits"], [])
        self.assertEqual(value["quotaWindows"], {"five_hour": "unsupported", "weekly": "unknown"})

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
