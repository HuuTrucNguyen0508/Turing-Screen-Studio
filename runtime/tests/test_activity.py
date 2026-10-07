"""Read-only activity checks using temporary, installed-schema metadata fixtures."""

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from turzx_studio import activity
from turzx_studio.activity import T3Activity


PREFIX = "orchestration_v2_projection_"
# Relevant columns transcribed from installed T3's schema 2. Deliberately
# independent of the reader's SCHEMA map; excluded content is a privacy canary.
DDL = """
CREATE TABLE orchestration_v2_projection_metadata (
 projection_name TEXT PRIMARY KEY, schema_version INTEGER, last_sequence INTEGER, updated_at TEXT);
CREATE TABLE orchestration_v2_events (sequence INTEGER PRIMARY KEY, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_threads (
 thread_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_runs (
 run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, provider_instance_id TEXT,
 provider_thread_id TEXT, status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_run_attempts (
 attempt_id TEXT PRIMARY KEY, run_id TEXT, thread_id TEXT, root_node_id TEXT,
 provider_thread_id TEXT, status TEXT, provider_instance_id TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_nodes (
 node_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, kind TEXT, status TEXT,
 completed_at TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_provider_threads (
 provider_thread_id TEXT PRIMARY KEY, provider_session_id TEXT, status TEXT,
 thread_id TEXT, provider_instance_id TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_provider_sessions (
 provider_session_id TEXT PRIMARY KEY, status TEXT, provider_instance_id TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_provider_turns (
 provider_turn_id TEXT PRIMARY KEY, provider_thread_id TEXT, thread_id TEXT,
 run_attempt_id TEXT, ordinal INTEGER, status TEXT, node_id TEXT, completed_at TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_runtime_requests (
 runtime_request_id TEXT PRIMARY KEY, provider_turn_id TEXT, kind TEXT, status TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_subagents (
 subagent_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, origin TEXT, status TEXT,
 completed_at TEXT, child_thread_id TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_messages (payload_json TEXT);
CREATE TABLE credentials (token TEXT);
"""
PRIVATE = '{"prompt":"private prompt","result":"private result","token":"private token"}'


def stamp(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.directory = self.home / ".t3/userdata"
        self.directory.mkdir(parents=True)
        self.database = self.directory / "statev2.sqlite"
        self.runtime = self.directory / "server-runtime.json"
        self.now = 1_790_000_000.0
        self.started = self.now - 3600
        self.write_runtime()
        with closing(sqlite3.connect(self.database)) as db:
            db.executescript(DDL)
            db.execute(f"INSERT INTO {PREFIX}metadata VALUES ('thread-projections',2,1,?)", (stamp(self.now),))
            db.execute("INSERT INTO orchestration_v2_events VALUES (1,?)", (PRIVATE,))
            db.execute(f"INSERT INTO {PREFIX}messages VALUES (?)", (PRIVATE,))
            db.execute("INSERT INTO credentials VALUES ('private token')")
            db.commit()
        self.probes = []

    def write_runtime(self, **fields):
        value = {"version": 1, "pid": 42, "startedAt": stamp(self.started)}
        value.update(fields)
        self.runtime.write_text(json.dumps(value))

    def sql(self, query, parameters=()):
        with closing(sqlite3.connect(self.database)) as db:
            db.execute(query, parameters)
            db.commit()

    def probe(self, pid, started, now):
        self.probes.append((pid, started, now))
        return True

    def reader(self, **kwargs):
        return T3Activity(self.home, clock=lambda: self.now, process_probe=self.probe, **kwargs)

    def add_thread(self, identity="one", title="Build dashboard", provider="codex-pro", status="running"):
        run, attempt, node, native, session, turn = (f"{name}-{identity}" for name in
                                                    ("run", "attempt", "node", "native", "session", "turn"))
        with closing(sqlite3.connect(self.database)) as db:
            db.execute(f"INSERT INTO {PREFIX}threads VALUES (?,?,NULL,?)", (identity, title, PRIVATE))
            db.execute(f"INSERT INTO {PREFIX}runs VALUES (?,?,1,?,?,?, ?,NULL,?)",
                       (run, identity, provider, native, status, stamp(self.now),
                        json.dumps({"activeAttemptId": attempt, "rootNodeId": node})))
            db.execute(f"INSERT INTO {PREFIX}run_attempts VALUES (?,?,?,?,?,'running',?,?)",
                       (attempt, run, identity, node, native, provider, PRIVATE))
            db.execute(f"INSERT INTO {PREFIX}nodes VALUES (?,?,?,'root_turn','running',NULL,?)",
                       (node, identity, run, PRIVATE))
            db.execute(f"INSERT INTO {PREFIX}provider_threads VALUES (?,?,'active',?,?,?)",
                       (native, session, identity, provider, PRIVATE))
            db.execute(f"INSERT INTO {PREFIX}provider_sessions VALUES (?,'ready',?,?)", (session, provider, PRIVATE))
            db.execute(f"INSERT INTO {PREFIX}provider_turns VALUES (?,?,?,?,1,'running',?,NULL,?)",
                       (turn, native, identity, attempt, node, PRIVATE))
            db.commit()
        return identity

    def add_agent(self, identity="agent", parent="one", child="child", origin="app_owned"):
        self.sql(f"INSERT INTO {PREFIX}subagents VALUES (?,?,?,?,'running',NULL,?,?)",
                 (identity, parent, "run-" + parent, origin, child, PRIVATE))

    def use_application_journal(self):
        # Current T3 migrated V2 events into the shared application journal.
        # Its projection cursor covers V2 thread events, not projects or V1.
        self.sql("""CREATE TABLE orchestration_events (
            sequence INTEGER PRIMARY KEY, application_event_version INTEGER,
            aggregate_kind TEXT, stream_id TEXT, payload_json TEXT, metadata_json TEXT)""")
        self.sql("INSERT INTO orchestration_events VALUES (1,2,'thread','one',?,?)",
                 (PRIVATE, PRIVATE))
        self.sql("DELETE FROM orchestration_v2_events")

    def assert_contract(self, value):
        self.assertEqual(set(value), {"working", "threads", "observedAt", "status", "note"})
        self.assertIn(value["status"], {"live", "stale", "unavailable"})
        self.assertLessEqual(len(value["threads"]), 5)
        self.assertIsInstance(value["note"], str)
        self.assertEqual(json.loads(json.dumps(value, allow_nan=False)), value)
        for row in value["threads"]:
            self.assertEqual(set(row), {"id", "title", "provider", "status"})
            self.assertLessEqual(len(row["title"]), 100)

    def assert_unknown(self, value, status="stale"):
        self.assert_contract(value)
        self.assertEqual(value["status"], status)
        self.assertIsNone(value["working"])
        self.assertEqual(value["threads"], [])
        self.assertNotIn("private", json.dumps(value))

    def test_status_captions_fit_compact_card_with_stale_prefix(self):
        for code, note in activity.NOTES.items():
            with self.subTest(code=code):
                self.assertLessEqual(len("Stale: " + note), 29)

    def test_verified_idle_is_zero(self):
        value = self.reader().snapshot()
        self.assert_contract(value)
        self.assertEqual(value["status"], "live")
        self.assertEqual(value["working"], 0)
        self.assertEqual(value["threads"], [])
        self.assertEqual(value["observedAt"], stamp(self.now))
        self.assertEqual(self.probes, [(42, self.started, self.now)])

    def test_running_thread_contract_and_detached_cache(self):
        self.add_thread()
        reader = self.reader()
        value = reader.snapshot()
        self.assert_contract(value)
        self.assertEqual(value["working"], 1)
        self.assertEqual(value["threads"], [{"id": "one", "title": "Build dashboard",
                                           "provider": "codex-pro", "status": "running"}])
        value["threads"][0]["title"] = "Changed by caller"
        value["threads"].append({})
        self.assertEqual(reader.snapshot()["threads"][0]["title"], "Build dashboard")
        self.assertEqual(len(reader.snapshot()["threads"]), 1)
        self.assertEqual(len(self.probes), 1)

    def test_total_exceeds_five_display_rows(self):
        for i in range(8):
            self.add_thread(str(i))
        value = self.reader().snapshot()
        self.assert_contract(value)
        self.assertEqual(value["status"], "live")
        self.assertEqual(value["working"], 8)
        self.assertEqual(len(value["threads"]), 5)

    def test_waiting_rows_do_not_count_and_running_rows_are_first(self):
        self.add_thread("waiting", status="waiting")
        self.add_thread("working")
        self.sql(f"UPDATE {PREFIX}nodes SET status='waiting' WHERE thread_id='waiting'")
        self.sql(f"UPDATE {PREFIX}provider_sessions SET status='waiting' WHERE provider_session_id='session-waiting'")
        value = self.reader().snapshot()
        self.assertEqual(value["working"], 1)
        self.assertEqual([r["status"] for r in value["threads"]], ["running", "waiting"])

    def test_pending_user_input_and_approval(self):
        for kind, status in (("user_input", "waiting_input"), ("command_approval", "waiting_approval"),
                             ("dynamic_tool_call", "running")):
            with self.subTest(kind=kind):
                self.add_thread(kind)
                self.sql(f"INSERT INTO {PREFIX}runtime_requests VALUES (?,?,?,'pending',?)",
                         (kind, "turn-" + kind, kind, PRIVATE))
                value = self.reader().snapshot()
                row = next(r for r in value["threads"] if r["id"] == kind)
                self.assertEqual(row["status"], status)

    def test_resolved_requests_do_not_block_execution(self):
        self.add_thread()
        self.sql(f"INSERT INTO {PREFIX}runtime_requests VALUES ('q','turn-one','user_input','resolved',?)", (PRIVATE,))
        self.assertEqual(self.reader().snapshot()["working"], 1)

    def test_idle_waiting_server_can_report_zero_with_waiting_row(self):
        self.add_thread(status="waiting")
        value = self.reader().snapshot()
        self.assertEqual(value["status"], "live")
        self.assertEqual(value["working"], 0)
        self.assertEqual(value["threads"][0]["status"], "waiting")

    def test_terminal_and_deleted_threads_do_not_count(self):
        for status in ("completed", "failed", "interrupted", "cancelled", "rolled_back", "queued"):
            self.add_thread(status, status=status)
        self.add_thread("deleted")
        self.sql(f"UPDATE {PREFIX}threads SET deleted_at=? WHERE thread_id='deleted'", (stamp(self.now),))
        self.assertEqual(self.reader().snapshot()["working"], 0)

    def test_child_threads_count_once_even_with_duplicate_agent_records(self):
        self.add_thread()
        self.add_thread("child", provider="claudeAgent")
        self.add_agent()
        self.add_agent("agent-copy")
        value = self.reader().snapshot()
        self.assertEqual(value["status"], "live")
        self.assertEqual(value["working"], 2)
        self.assertEqual({r["id"] for r in value["threads"]}, {"one", "child"})

    def test_stale_agent_record_after_child_finishes_is_not_running(self):
        self.add_thread()
        self.add_thread("child", status="completed")
        self.add_agent()
        self.assertEqual(self.reader().snapshot()["working"], 1)

    def test_old_agent_record_does_not_make_verified_idle_unknown(self):
        self.add_thread(status="completed")
        self.add_thread("child", status="completed")
        self.add_agent()
        self.sql(f"UPDATE {PREFIX}metadata SET updated_at=?", (stamp(self.now - 121),))
        value = self.reader().snapshot()
        self.assertEqual(value["status"], "live")
        self.assertEqual(value["working"], 0)

    def test_child_keeps_running_after_parent_finishes(self):
        self.add_thread(status="completed")
        self.add_thread("child")
        self.add_agent()
        self.assertEqual(self.reader().snapshot()["working"], 1)

    def test_native_agent_without_app_run_is_not_extra_thread(self):
        self.add_thread()
        self.add_agent(child=None, origin="provider_native")
        self.assertEqual(self.reader().snapshot()["working"], 1)

    def test_missing_child_metadata_is_unknown(self):
        self.add_thread()
        self.add_agent()
        self.assert_unknown(self.reader().snapshot())

    def test_missing_run_attempt_and_provider_evidence_is_unknown(self):
        self.add_thread()
        for suffix in ("run_attempts", "provider_threads", "provider_sessions", "provider_turns", "nodes"):
            with self.subTest(table=suffix):
                copy = self.home / (suffix + ".sqlite")
                with closing(sqlite3.connect(self.database)) as source, closing(sqlite3.connect(copy)) as target:
                    source.backup(target)
                    target.execute(f"DELETE FROM {PREFIX}{suffix}")
                    target.commit()
                self.assert_unknown(self.reader(database_path=copy).snapshot())

    def test_inconsistent_lifecycle_is_unknown(self):
        self.add_thread()
        cases = (("provider_threads", "status", "idle"), ("provider_sessions", "status", "stopped"),
                 ("provider_turns", "status", "completed"), ("provider_turns", "completed_at", stamp(self.now)),
                 ("nodes", "status", "completed"), ("nodes", "completed_at", stamp(self.now)),
                 ("run_attempts", "status", "superseded"), ("runs", "completed_at", stamp(self.now)))
        for suffix, column, value in cases:
            with self.subTest(table=suffix, column=column):
                copy = self.home / (suffix + column + ".sqlite")
                with closing(sqlite3.connect(self.database)) as source, closing(sqlite3.connect(copy)) as target:
                    source.backup(target)
                    target.execute(f"UPDATE {PREFIX}{suffix} SET {column}=?", (value,))
                    target.commit()
                self.assert_unknown(self.reader(database_path=copy).snapshot())

    def test_mismatched_thread_provider_root_or_run_is_unknown(self):
        self.add_thread()
        for suffix, column in (("run_attempts", "run_id"), ("run_attempts", "thread_id"),
                               ("run_attempts", "root_node_id"), ("provider_threads", "thread_id"),
                               ("provider_sessions", "provider_instance_id"),
                               ("provider_turns", "thread_id"), ("nodes", "run_id"), ("nodes", "kind")):
            with self.subTest(table=suffix, column=column):
                copy = self.home / (suffix + column + ".sqlite")
                with closing(sqlite3.connect(self.database)) as source, closing(sqlite3.connect(copy)) as target:
                    source.backup(target)
                    target.execute(f"UPDATE {PREFIX}{suffix} SET {column}='wrong'")
                    target.commit()
                self.assert_unknown(self.reader(database_path=copy).snapshot())

    def test_latest_root_turn_is_used_within_multi_turn_attempt(self):
        self.add_thread()
        self.sql(f"UPDATE {PREFIX}provider_turns SET status='completed',completed_at=?", (stamp(self.now - 10),))
        self.sql(f"INSERT INTO {PREFIX}provider_turns VALUES ('turn-new','native-one','one','attempt-one',2,'running','node-one',NULL,?)", (PRIVATE,))
        self.assertEqual(self.reader().snapshot()["working"], 1)
        self.sql(f"UPDATE {PREFIX}provider_turns SET status='completed' WHERE provider_turn_id='turn-new'")
        self.assert_unknown(self.reader().snapshot())

    def test_provider_turn_from_other_attempt_is_not_evidence(self):
        self.add_thread()
        self.sql(f"UPDATE {PREFIX}provider_turns SET run_attempt_id='old-attempt'")
        self.assert_unknown(self.reader().snapshot())

    def test_duplicate_active_runs_are_unknown(self):
        self.add_thread()
        self.sql(f"INSERT INTO {PREFIX}runs SELECT 'duplicate',thread_id,2,provider_instance_id,provider_thread_id,status,requested_at,completed_at,payload_json FROM {PREFIX}runs")
        self.assert_unknown(self.reader().snapshot())

    def test_orphan_active_run_is_unknown(self):
        self.add_thread()
        self.sql(f"DELETE FROM {PREFIX}threads")
        self.assert_unknown(self.reader().snapshot())

    def test_titles_and_provider_names_are_sanitized_and_bounded(self):
        self.add_thread(title="\x1b\x00\u202e\u200bBuild\n\t dashboard  " + "x" * 200,
                        provider="codex\n\tpro\u202e")
        value = self.reader().snapshot()
        self.assert_contract(value)
        self.assertTrue(value["threads"][0]["title"].startswith("Build dashboard "))
        self.assertEqual(len(value["threads"][0]["title"]), 100)
        self.assertEqual(value["threads"][0]["provider"], "codex pro")

    def test_empty_title_gets_safe_fallback(self):
        self.add_thread(title="\x00\u202e\n")
        self.assertEqual(self.reader().snapshot()["threads"][0]["title"], "Untitled thread")

    def test_invalid_provider_identity_is_unknown(self):
        self.add_thread(provider="\x00\n")
        self.assert_unknown(self.reader().snapshot(), "unavailable")

    def test_missing_files_are_unavailable_not_idle(self):
        self.runtime.unlink()
        self.assert_unknown(self.reader().snapshot(), "unavailable")
        self.write_runtime()
        self.database.unlink()
        self.assert_unknown(self.reader().snapshot(), "unavailable")
        self.assertFalse(self.database.exists())

    def test_runtime_malformed_unsupported_and_oversize(self):
        for raw in ("not json", "[]", json.dumps({"version": 2, "pid": 42}),
                    json.dumps({"version": True, "pid": 42}), json.dumps({"version": 1, "pid": True}),
                    json.dumps({"version": 1, "pid": 0}), " " * 8193, "[" * 2000 + "]" * 2000):
            with self.subTest(raw=raw[:40]):
                self.runtime.write_text(raw)
                self.assert_unknown(self.reader().snapshot(), "unavailable")

    @unittest.skipUnless(hasattr(os, "mkfifo"), "requires FIFO support")
    def test_non_regular_runtime_metadata_fails_without_blocking(self):
        self.runtime.unlink()
        os.mkfifo(self.runtime)
        self.assert_unknown(self.reader().snapshot(), "unavailable")

    def test_server_dead_or_unverifiable_is_unknown(self):
        for answer in (False, None):
            with self.subTest(answer=answer):
                reader = T3Activity(self.home, clock=lambda: self.now, process_probe=lambda *args: answer)
                self.assert_unknown(reader.snapshot())

    def test_failed_process_probe_is_unknown_without_leaking_error(self):
        def denied(*args):
            raise PermissionError("private token")
        value = T3Activity(self.home, clock=lambda: self.now, process_probe=denied).snapshot()
        self.assert_unknown(value)

    def test_unknown_projection_schema_is_unavailable(self):
        self.sql(f"UPDATE {PREFIX}metadata SET schema_version=3")
        self.assert_unknown(self.reader().snapshot(), "unavailable")

    def test_missing_required_columns_are_unavailable(self):
        self.sql(f"ALTER TABLE {PREFIX}run_attempts RENAME COLUMN status TO old_status")
        self.assert_unknown(self.reader().snapshot(), "unavailable")

    def test_projection_lag_is_unknown_and_preserves_observation(self):
        self.sql("INSERT INTO orchestration_v2_events VALUES (2,?)", (PRIVATE,))
        value = self.reader().snapshot()
        self.assert_unknown(value)
        self.assertEqual(value["observedAt"], stamp(self.now))

    def test_migrated_application_journal_verifies_running_threads(self):
        self.add_thread("a40949e2-58f7-46ac-896f-51ddf4397643")
        self.add_thread("child")
        self.add_agent(parent="a40949e2-58f7-46ac-896f-51ddf4397643")
        self.use_application_journal()
        value = self.reader().snapshot()
        self.assert_contract(value)
        self.assertEqual(value["status"], "live")
        self.assertEqual(value["working"], 2)

    def test_projection_cursor_excludes_projects_and_legacy_thread_events(self):
        self.add_thread()
        self.use_application_journal()
        for sequence, version, kind in ((2, 1, "thread"), (3, 2, "project"),
                                        (4, 1, "project"), (5, 2, "other")):
            self.sql("INSERT INTO orchestration_events VALUES (?,?,?,'other',?,?)",
                     (sequence, version, kind, PRIVATE, PRIVATE))
        self.assertEqual(self.reader().snapshot()["working"], 1)

    def test_migrated_projection_lag_never_uses_legacy_matching_cursor(self):
        self.add_thread()
        self.use_application_journal()
        self.sql("INSERT INTO orchestration_events VALUES (2,2,'thread','child',?,?)",
                 (PRIVATE, PRIVATE))
        self.sql("INSERT INTO orchestration_v2_events VALUES (1,?)", (PRIVATE,))
        value = self.reader().snapshot()
        self.assert_unknown(value)
        self.assertIn("incomplete", value["note"])
        self.assertEqual(value["observedAt"], stamp(self.now))

    def test_empty_application_journal_does_not_use_legacy_matching_cursor(self):
        self.use_application_journal()
        self.sql("DELETE FROM orchestration_events")
        self.sql("INSERT INTO orchestration_v2_events VALUES (1,?)", (PRIVATE,))
        self.assert_unknown(self.reader().snapshot())

    def test_unsupported_application_journal_schema_never_falls_back(self):
        self.use_application_journal()
        self.sql("INSERT INTO orchestration_v2_events VALUES (1,?)", (PRIVATE,))
        for column in ("sequence", "application_event_version", "aggregate_kind"):
            with self.subTest(column=column):
                copy = self.home / (column + ".sqlite")
                with closing(sqlite3.connect(self.database)) as source, closing(sqlite3.connect(copy)) as target:
                    source.backup(target)
                    target.execute(f"ALTER TABLE orchestration_events RENAME COLUMN {column} TO old_column")
                    target.commit()
                self.assert_unknown(self.reader(database_path=copy).snapshot(), "unavailable")

    def test_empty_application_journal_with_zero_cursor_is_verified_idle(self):
        self.use_application_journal()
        self.sql("DELETE FROM orchestration_events")
        self.sql(f"UPDATE {PREFIX}metadata SET last_sequence=0")
        self.assertEqual(self.reader().snapshot()["working"], 0)

    def test_migrated_journal_does_not_require_legacy_event_table(self):
        self.use_application_journal()
        self.sql("DROP TABLE orchestration_v2_events")
        self.assertEqual(self.reader().snapshot()["working"], 0)

    def test_long_silent_current_server_turn_remains_verified_running(self):
        self.add_thread()
        self.use_application_journal()
        reader = self.reader()
        observed = stamp(self.now)
        self.assertEqual(reader.snapshot()["working"], 1)
        # No fixture writes or new thread events during this silent turn.
        self.now += 181
        value = reader.snapshot()
        self.assert_contract(value)
        self.assertEqual(value["status"], "live")
        self.assertEqual(value["working"], 1)
        self.assertEqual(value["threads"][0]["status"], "running")
        self.assertEqual(value["observedAt"], observed)
        self.assertEqual(len(self.probes), 2)
        self.now += 2
        self.assertEqual(reader.snapshot(), value)
        self.assertEqual(len(self.probes), 2)

    def test_cached_current_server_execution_does_not_expire_with_event_age(self):
        self.add_thread()
        self.sql(f"UPDATE {PREFIX}metadata SET updated_at=?", (stamp(self.now - 119),))
        reader = self.reader()
        value = reader.snapshot()
        self.assertEqual(value["working"], 1)
        self.now += 2
        self.assertEqual(reader.snapshot(), value)
        self.assertEqual(len(self.probes), 1)

    def test_old_idle_projection_after_server_restart_is_verified_zero(self):
        self.use_application_journal()
        observed = stamp(self.now)
        self.now += 181
        self.started = self.now
        self.write_runtime()
        value = self.reader().snapshot()
        self.assert_contract(value)
        self.assertEqual(value["status"], "live")
        self.assertEqual(value["working"], 0)
        self.assertEqual(value["threads"], [])
        self.assertEqual(value["observedAt"], observed)
        self.assertEqual(self.probes, [(42, self.started, self.now)])

    def test_old_completed_child_agent_after_restart_is_verified_idle(self):
        self.add_thread(status="completed")
        self.add_thread("child", status="completed")
        self.add_agent()
        self.use_application_journal()
        self.now += 181
        self.started = self.now
        self.write_runtime()
        value = self.reader().snapshot()
        self.assertEqual(value["status"], "live")
        self.assertEqual(value["working"], 0)

    def test_old_active_projection_after_server_restart_is_unknown(self):
        self.add_thread()
        self.use_application_journal()
        observed = stamp(self.now)
        self.now += 181
        self.started = self.now
        self.write_runtime()
        value = self.reader().snapshot()
        self.assert_unknown(value)
        self.assertEqual(value["observedAt"], observed)

    def test_long_silent_turn_with_current_cursor_behind_is_unknown(self):
        self.add_thread()
        self.use_application_journal()
        reader = self.reader()
        self.assertEqual(reader.snapshot()["working"], 1)
        observed = stamp(self.now)
        self.now += 181
        self.sql("INSERT INTO orchestration_events VALUES (2,2,'thread','one',?,?)",
                 (PRIVATE, PRIVATE))
        value = reader.snapshot()
        self.assert_unknown(value)
        self.assertIn("incomplete", value["note"])
        self.assertEqual(value["observedAt"], observed)

    def test_future_projection_is_unknown_even_when_idle(self):
        self.sql(f"UPDATE {PREFIX}metadata SET updated_at=?", (stamp(self.now + 6),))
        self.assert_unknown(self.reader().snapshot())

    def test_invalid_and_naive_timestamp_is_unavailable(self):
        for raw in ("invalid", "2026-10-07T12:00:00", None):
            with self.subTest(raw=raw):
                self.sql(f"UPDATE {PREFIX}metadata SET updated_at=?", (raw,))
                self.assert_unknown(self.reader().snapshot(), "unavailable")

    def test_cache_refresh_and_clock_rollback(self):
        reader = self.reader()
        self.assertEqual(reader.snapshot()["working"], 0)
        self.add_thread()
        self.now += 4
        self.assertEqual(reader.snapshot()["working"], 0)
        self.now += 1
        self.assertEqual(reader.snapshot()["working"], 1)
        self.now -= 2
        self.assertEqual(reader.snapshot()["working"], 1)
        self.assertEqual(len(self.probes), 3)

    def test_invalid_clock_is_json_safe(self):
        for now in (float("nan"), float("inf"), True, None, "now"):
            with self.subTest(now=now):
                self.now = now
                self.assert_unknown(self.reader().snapshot(), "unavailable")

    def test_injected_paths_with_uri_characters(self):
        database = self.home / "test # ? database.sqlite"
        runtime = self.home / "test runtime.json"
        self.database.rename(database)
        self.runtime.rename(runtime)
        value = self.reader(database_path=database, runtime_path=runtime).snapshot()
        self.assertEqual(value["working"], 0)

    def test_enumeration_bound_never_reports_a_partial_total(self):
        for i in range(4):
            self.add_thread(str(i))
        with patch.object(activity, "MAX_ROWS", 3):
            self.assert_unknown(self.reader().snapshot())

    def test_subagent_enumeration_bound_never_reports_idle(self):
        self.add_thread(status="completed")
        self.add_thread("child", status="completed")
        for i in range(4):
            self.add_agent(str(i))
        with patch.object(activity, "MAX_ROWS", 3):
            self.assert_unknown(self.reader().snapshot())

    def test_query_budget_is_enforced(self):
        for i in range(12):
            self.add_thread(str(i))
        for setting, limit in (("SQL_STEPS", 0), ("SQL_SECONDS", -1)):
            with self.subTest(setting=setting), patch.object(activity, setting, limit):
                value = self.reader().snapshot()
                self.assert_unknown(value)
                self.assertIn("query budget", value["note"])

    def test_large_or_invalid_run_metadata_is_unknown(self):
        self.add_thread()
        for raw in ("malformed private token", " " * 8193, '{"activeAttemptId":null}'):
            with self.subTest(raw=raw[:40]):
                self.sql(f"UPDATE {PREFIX}runs SET payload_json=?", (raw,))
                self.assert_unknown(self.reader().snapshot())

    def test_database_lock_and_corruption_are_unavailable(self):
        with closing(sqlite3.connect(self.database)) as lock:
            lock.execute("BEGIN EXCLUSIVE")
            value = self.reader().snapshot()
            self.assert_unknown(value, "unavailable")
            self.assertIn("busy", value["note"])
            lock.rollback()
        self.database.write_bytes(b"not a database private token")
        self.assert_unknown(self.reader().snapshot(), "unavailable")

    def test_reader_does_not_change_database_runtime_or_sidecars(self):
        self.add_thread()
        for migrated in (False, True):
            with self.subTest(migrated=migrated):
                if migrated:
                    self.use_application_journal()
                before = {p.name: hashlib.sha256(p.read_bytes()).digest() for p in self.directory.iterdir()}
                self.assertEqual(self.reader().snapshot()["working"], 1)
                after = {p.name: hashlib.sha256(p.read_bytes()).digest() for p in self.directory.iterdir()}
                self.assertEqual(after, before)

    def test_only_allowlisted_metadata_is_selected(self):
        self.add_thread()
        connect = sqlite3.connect
        accesses = set()

        def authorizer(operation, table, column, database, trigger):
            if operation == sqlite3.SQLITE_READ:
                accesses.add((table, column))
                if table in (PREFIX + "messages", "credentials"):
                    return sqlite3.SQLITE_DENY
                if column == "payload_json" and table != PREFIX + "runs":
                    return sqlite3.SQLITE_DENY
                if table == "orchestration_events" and column not in {
                        "sequence", "application_event_version", "aggregate_kind"}:
                    return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        def audited_connect(*args, **kwargs):
            self.assertTrue(kwargs["uri"])
            self.assertTrue(args[0].endswith("?mode=ro"))
            db = connect(*args, **kwargs)
            db.set_authorizer(authorizer)
            return db

        for migrated in (False, True):
            with self.subTest(migrated=migrated):
                if migrated:
                    self.use_application_journal()
                accesses.clear()
                with patch.object(activity.sqlite3, "connect", audited_connect):
                    value = self.reader().snapshot()
                self.assertEqual(value["working"], 1)
                self.assertNotIn("private", json.dumps(value))
                if migrated:
                    self.assertEqual({column for table, column in accesses if table == "orchestration_events"},
                                     {"sequence", "application_event_version", "aggregate_kind"})
                    self.assertNotIn(("orchestration_v2_events", "sequence"), accesses)
                else:
                    self.assertIn(("orchestration_v2_events", "sequence"), accesses)


class ProcessProbeTests(unittest.TestCase):
    def test_pid_reuse_zombie_and_unexpected_process_are_not_alive(self):
        now, started = 1000.0, 910.0

        def data(name="t3code", state="S", ticks=1000):
            fields = [state] + ["0"] * 18 + [str(ticks)]
            return ("42 (" + name + ") " + " ".join(fields)).encode()

        for raw in (data(ticks=9000), data(state="Z"), data(name="python")):
            with self.subTest(raw=raw), patch.object(activity, "_read_bounded", side_effect=[raw, b"100 0"]), patch.object(activity.os, "sysconf", return_value=100):
                self.assertFalse(activity._process_alive(42, started, now))

    def test_matching_server_identity_is_alive(self):
        fields = ["S"] + ["0"] * 18 + ["1000"]
        raw = ("42 (t3code) " + " ".join(fields)).encode()
        with patch.object(activity, "_read_bounded", side_effect=[raw, b"100 0"]), patch.object(activity.os, "sysconf", return_value=100):
            self.assertTrue(activity._process_alive(42, 910, 1000))

    def test_missing_process_or_denied_procfs(self):
        with patch.object(activity, "_read_bounded", side_effect=FileNotFoundError), patch.object(Path, "is_dir", return_value=True):
            self.assertFalse(activity._process_alive(42, 910, 1000))
        with patch.object(activity, "_read_bounded", side_effect=PermissionError):
            self.assertIsNone(activity._process_alive(42, 910, 1000))


if __name__ == "__main__":
    unittest.main()
