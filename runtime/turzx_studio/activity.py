"""Bounded local T3 activity, independent of usage accounting.

Verified against installed T3's orchestration V2 projection schema 2 and
PersistedServerRuntimeState v1. Only scalar execution metadata and titles are
selected. Messages, prompts, results, native refs and credentials are never read.
Provider PIDs are not persisted by T3. The server PID and start time are checked;
provider execution is established by matching run, attempt, turn and node state.
App-owned children count through their own runs, never twice through subagents.
"""

from contextlib import closing
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sqlite3
import stat
import threading
import time
import unicodedata
from typing import Callable


CACHE_SECONDS = 5
MAX_ROWS = 512
MAX_ITEMS = 5
SQL_SECONDS = .2
SQL_STEPS = 250_000
MAX_FILE_BYTES = 8192
PREFIX = "orchestration_v2_projection_"

# Require the actual durable schema, rather than guessing from legacy tables.
SCHEMA = {
    "metadata": {"projection_name", "schema_version", "last_sequence", "updated_at"},
    "threads": {"thread_id", "title", "deleted_at"},
    "runs": {"run_id", "thread_id", "ordinal", "provider_instance_id", "provider_thread_id",
             "status", "requested_at", "completed_at", "payload_json"},
    "run_attempts": {"attempt_id", "run_id", "thread_id", "root_node_id", "provider_thread_id",
                     "status", "provider_instance_id"},
    "nodes": {"node_id", "thread_id", "run_id", "kind", "status", "completed_at"},
    "provider_threads": {"provider_thread_id", "provider_session_id", "status", "thread_id",
                         "provider_instance_id"},
    "provider_sessions": {"provider_session_id", "status", "provider_instance_id"},
    "provider_turns": {"provider_turn_id", "provider_thread_id", "thread_id", "run_attempt_id",
                       "ordinal", "status", "node_id", "completed_at"},
    "runtime_requests": {"provider_turn_id", "kind", "status"},
    "subagents": {"subagent_id", "thread_id", "run_id", "origin", "status", "completed_at",
                  "child_thread_id"},
}

NOTES = {
    "invalid_clock": "Clock unavailable.",
    "runtime_missing": "Server data missing.",
    "runtime_invalid": "Invalid server data.",
    "runtime_dead": "Server stopped.",
    "runtime_unverified": "Server unverified.",
    "database_missing": "Activity DB missing.",
    "database_unreadable": "Activity read failed.",
    "database_busy": "Activity DB busy.",
    "unknown_schema": "Unsupported schema.",
    "invalid_state": "Invalid activity data.",
    "source_stale": "Invalid event time.",
    "projection_behind": "Projection incomplete.",
    "partial": "Read limit, unknown.",
    "inconsistent_state": "Conflicting execution.",
    "provider_unverified": "Execution unverified.",
    "read_bound": "Over query budget.",
}


class _Unavailable(Exception):
    def __init__(self, code: str, status: str = "unavailable", observed: float | None = None):
        self.code, self.status, self.observed = code, status, observed


def _stamp(value: object) -> float:
    if not isinstance(value, str) or len(value) > 64:
        raise _Unavailable("invalid_state")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError("timezone")
        value = stamp.timestamp()
        if not math.isfinite(value):
            raise ValueError("timestamp")
        return value
    except (ValueError, OverflowError):
        raise _Unavailable("invalid_state") from None


def _iso(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def _read_bounded(path: Path) -> bytes:
    # Nonblocking open also bounds failure for a FIFO accidentally replacing
    # the metadata file. Procfs stat/uptime are regular files of reported size 0.
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise _Unavailable("runtime_invalid")
        raw = handle.read(MAX_FILE_BYTES + 1)
    if len(raw) > MAX_FILE_BYTES:
        raise _Unavailable("runtime_invalid")
    return raw


def _process_alive(pid: int, started: float, now: float) -> bool | None:
    """Linux identity check without cmdline, environ, signals or process scans.

    Start time guards against PID reuse. Non-Linux or inaccessible /proc is
    unknown, never evidence for an empty activity list.
    """
    try:
        stat = _read_bounded(Path(f"/proc/{pid}/stat")).decode()
        name = stat[stat.index("(") + 1:stat.rindex(")")]
        fields = stat[stat.rindex(")") + 2:].split()
        uptime = float(_read_bounded(Path("/proc/uptime")).split()[0])
        born = now - uptime + int(fields[19]) / os.sysconf("SC_CLK_TCK")
        return (name in {"t3code", "node", "nodejs", "bun", "electron"}
                and fields[0] not in {"Z", "X"} and abs(born - started) <= 30)
    except FileNotFoundError:
        return False if Path("/proc").is_dir() else None
    except (OSError, ValueError, IndexError, UnicodeError, _Unavailable):
        return None


def _text(value: str, limit: int) -> str:
    # Drop bidi overrides, ANSI/control characters, surrogates and zero-width
    # formatting. Collapse whitespace so one thread occupies one display row.
    clean = "".join(" " if c.isspace() else c for c in value
                    if c.isspace() or not unicodedata.category(c).startswith("C"))
    return " ".join(clean.split())[:limit]


def _item(identity: object, title: object, provider: object, status: str) -> dict:
    if isinstance(title, bytes):
        title = title.decode("utf-8", errors="replace")
    if (not isinstance(identity, str) or not identity or len(identity) > 512
            or any(unicodedata.category(c).startswith("C") for c in identity)
            or not isinstance(title, str) or not isinstance(provider, str)
            or not _text(provider, 80)):
        raise _Unavailable("invalid_state")
    return {"id": identity, "title": _text(title, 100) or "Untitled thread",
            "provider": _text(provider, 80), "status": status}


# A run may span multiple native turns under one attempt, e.g. a Codex goal.
# Read only its latest provider turn. A root node's provider_turn_id can be null.
RUN_QUERY = f"""
SELECT substr(r.thread_id, 1, 513) AS thread_id,
       t.thread_id IS NOT NULL AS thread_exists,
       substr(CAST(t.title AS BLOB), 1, 4096) AS title,
       substr(r.provider_instance_id, 1, 128) AS provider, r.status, r.completed_at,
       a.status AS attempt_status,
       a.run_id = r.run_id AND a.thread_id = r.thread_id
         AND a.provider_thread_id = r.provider_thread_id
         AND a.provider_instance_id = r.provider_instance_id
         AND a.root_node_id = CASE WHEN length(CAST(r.payload_json AS BLOB)) <= 8192
           THEN CASE WHEN json_valid(r.payload_json)
             THEN json_extract(r.payload_json, '$.rootNodeId') END END AS attempt_matches,
       pt.status AS thread_status, ps.status AS session_status,
       pt.thread_id = r.thread_id AND pt.provider_instance_id = r.provider_instance_id
         AND ps.provider_instance_id = r.provider_instance_id AS provider_matches,
       turn.status AS turn_status, turn.completed_at AS turn_completed,
       turn.thread_id = r.thread_id AND turn.provider_thread_id = r.provider_thread_id
         AND turn.node_id = a.root_node_id AS turn_matches,
       n.status AS node_status, n.completed_at AS node_completed,
       n.thread_id = r.thread_id AND n.run_id = r.run_id
         AND n.kind = 'root_turn' AS node_matches,
       EXISTS(SELECT 1 FROM {PREFIX}runtime_requests q
              WHERE q.provider_turn_id = turn.provider_turn_id AND q.status = 'pending'
                AND q.kind != 'dynamic_tool_call') AS waiting,
       EXISTS(SELECT 1 FROM {PREFIX}runtime_requests q
              WHERE q.provider_turn_id = turn.provider_turn_id AND q.status = 'pending'
                AND q.kind LIKE '%approval%') AS approval
FROM {PREFIX}runs r
LEFT JOIN {PREFIX}threads t ON t.thread_id = r.thread_id
LEFT JOIN {PREFIX}run_attempts a ON a.attempt_id = CASE
    WHEN length(CAST(r.payload_json AS BLOB)) <= 8192 THEN CASE
      WHEN json_valid(r.payload_json) THEN json_extract(r.payload_json, '$.activeAttemptId')
    END END
LEFT JOIN {PREFIX}provider_threads pt ON pt.provider_thread_id = r.provider_thread_id
LEFT JOIN {PREFIX}provider_sessions ps ON ps.provider_session_id = pt.provider_session_id
LEFT JOIN {PREFIX}provider_turns turn ON turn.provider_turn_id = (
    SELECT p.provider_turn_id FROM {PREFIX}provider_turns p
    WHERE p.run_attempt_id = a.attempt_id AND p.node_id = a.root_node_id
      AND p.provider_thread_id = r.provider_thread_id
    ORDER BY p.ordinal DESC LIMIT 1)
LEFT JOIN {PREFIX}nodes n ON n.node_id = turn.node_id
WHERE r.status IN ('running', 'waiting') AND t.deleted_at IS NULL
ORDER BY r.requested_at DESC, r.run_id
LIMIT ?
"""


SUBAGENT_QUERY = f"""
SELECT substr(s.child_thread_id, 1, 513) AS child_thread_id,
       s.origin, s.completed_at,
       child.thread_id IS NOT NULL AS child_exists, child.deleted_at,
       (SELECT r.status FROM {PREFIX}runs r WHERE r.thread_id = s.child_thread_id
        ORDER BY r.ordinal DESC LIMIT 1) AS child_run_status
FROM {PREFIX}subagents s
JOIN {PREFIX}threads t ON t.thread_id = s.thread_id
LEFT JOIN {PREFIX}threads child ON child.thread_id = s.child_thread_id
WHERE s.status IN ('running', 'waiting') AND t.deleted_at IS NULL
  AND s.origin = 'app_owned'
ORDER BY s.subagent_id
LIMIT ?
"""


def _latest_thread_sequence(db: sqlite3.Connection) -> int:
    # Installed T3's ApplicationEventSource migration moved V2 events into
    # orchestration_events. EventStore.latestSequence and projection verify
    # cover only version-2 thread events there, excluding projects and V1.
    # Never choose a journal by whether its cursor happens to match: the old
    # table can remain empty or retain historical rows after the migration.
    columns = {row[1] for row in db.execute("PRAGMA table_info(orchestration_events)").fetchmany(128)}
    if columns:
        if not {"sequence", "application_event_version", "aggregate_kind"} <= columns:
            raise _Unavailable("unknown_schema")
        query = ("SELECT sequence FROM orchestration_events "
                 "WHERE application_event_version = 2 AND aggregate_kind = 'thread' "
                 "ORDER BY sequence DESC LIMIT 1")
    else:
        columns = {row[1] for row in db.execute("PRAGMA table_info(orchestration_v2_events)").fetchmany(128)}
        if "sequence" not in columns:
            raise _Unavailable("unknown_schema")
        query = "SELECT sequence FROM orchestration_v2_events ORDER BY sequence DESC LIMIT 1"
    # Read sequence and classification columns only, never event payloads.
    sequence = db.execute(query).fetchone()
    return sequence[0] if sequence else 0


class T3Activity:
    """Synchronous snapshot with a five-second cache and no worker or network.

    `working` counts verified running app threads, independently of the five
    displayed rows. Waiting rows are included but do not count as working.
    Native agents without app runs are not additional app threads. A verified
    idle server reports zero; unknown execution reports null. This is local
    durable execution evidence, not a per-provider process health check.
    """

    def __init__(self, home: Path | None = None, clock: Callable[[], float] = time.time,
                 *, database_path: Path | None = None, runtime_path: Path | None = None,
                 process_probe: Callable[[int, float, float], bool | None] = _process_alive):
        self.home = Path(home) if home is not None else Path.home()
        self.database_path = (Path(database_path) if database_path is not None
                              else self.home / ".t3/userdata/statev2.sqlite")
        self.runtime_path = (Path(runtime_path) if runtime_path is not None
                             else self.home / ".t3/userdata/server-runtime.json")
        self.clock, self.process_probe = clock, process_probe
        self._cached: dict | None = None
        self._cached_at: float | None = None
        self._lock = threading.Lock()

    def snapshot(self) -> dict:
        with self._lock:
            now = self.clock()
            if type(now) not in (int, float) or not math.isfinite(now):
                return self._failure(_Unavailable("invalid_clock"))
            if self._cached_at is not None and 0 <= now - self._cached_at < CACHE_SECONDS:
                return deepcopy(self._cached)
            try:
                value = self._collect(now)
            except _Unavailable as error:
                value = self._failure(error)
            self._cached, self._cached_at = value, now
            return deepcopy(value)

    @staticmethod
    def _failure(error: _Unavailable) -> dict:
        return {"status": error.status, "working": None, "threads": [],
                "observedAt": _iso(error.observed) if error.observed is not None else None,
                "note": NOTES[error.code]}

    def _runtime(self, now: float) -> float:
        try:
            runtime = json.loads(_read_bounded(self.runtime_path))
        except FileNotFoundError:
            raise _Unavailable("runtime_missing") from None
        except (OSError, ValueError, UnicodeError, RecursionError):
            raise _Unavailable("runtime_invalid") from None
        if (not isinstance(runtime, dict) or type(runtime.get("version")) is not int
                or runtime["version"] != 1
                or type(runtime.get("pid")) is not int or runtime["pid"] <= 0):
            raise _Unavailable("runtime_invalid")
        started = _stamp(runtime.get("startedAt"))
        if started > now + 5:
            raise _Unavailable("runtime_invalid")
        try:
            alive = self.process_probe(runtime["pid"], started, now)
        except (OSError, ValueError):
            alive = None
        if alive is not True:
            raise _Unavailable("runtime_dead" if alive is False else "runtime_unverified", "stale")
        return started

    def _collect(self, now: float) -> dict:
        started = self._runtime(now)
        path = self.database_path.absolute()
        try:
            if not path.is_file():
                raise _Unavailable("database_missing")
        except OSError:
            raise _Unavailable("database_unreadable") from None
        deadline = time.monotonic() + SQL_SECONDS
        steps = 0

        def interrupt():
            nonlocal steps
            steps += 1000
            return steps > SQL_STEPS or time.monotonic() > deadline

        try:
            with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=.05)) as db:
                db.row_factory = sqlite3.Row
                db.set_progress_handler(interrupt, 1000)
                db.execute("PRAGMA query_only=ON")
                db.execute("BEGIN")
                for suffix, required in SCHEMA.items():
                    columns = {row[1] for row in db.execute(f"PRAGMA table_info({PREFIX}{suffix})").fetchmany(128)}
                    if not required <= columns:
                        raise _Unavailable("unknown_schema")
                metadata = db.execute(f"SELECT schema_version, last_sequence, updated_at FROM {PREFIX}metadata "
                                      "WHERE projection_name = 'thread-projections'").fetchone()
                if metadata is None or metadata["schema_version"] != 2:
                    raise _Unavailable("unknown_schema")
                observed = _stamp(metadata["updated_at"])
                if observed > now + 5:
                    raise _Unavailable("source_stale", "stale", observed)
                if metadata["last_sequence"] != _latest_thread_sequence(db):
                    raise _Unavailable("projection_behind", "stale", observed)
                runs = db.execute(RUN_QUERY, (MAX_ROWS + 1,)).fetchmany(MAX_ROWS + 1)
                agents = db.execute(SUBAGENT_QUERY, (MAX_ROWS + 1,)).fetchmany(MAX_ROWS + 1)
                if len(runs) > MAX_ROWS or len(agents) > MAX_ROWS:
                    raise _Unavailable("partial", "stale", observed)
                # Projection updates are thread events, not heartbeats. A
                # complete idle projection remains valid across restarts;
                # active execution must have evidence from this server boot.
                if runs and observed < started - 5:
                    raise _Unavailable("source_stale", "stale", observed)
                items, seen_threads = [], set()
                for row in runs:
                    if not row["thread_exists"] or row["thread_id"] in seen_threads:
                        raise _Unavailable("inconsistent_state", "stale", observed)
                    seen_threads.add(row["thread_id"])
                    if row["completed_at"] is not None:
                        raise _Unavailable("inconsistent_state", "stale", observed)
                    if (row["attempt_status"] != "running" or row["attempt_matches"] != 1
                            or row["provider_matches"] != 1 or row["turn_matches"] != 1
                            or row["node_matches"] != 1 or row["thread_status"] != "active"
                            or row["session_status"] not in {"ready", "running", "waiting"}
                            or row["turn_status"] != "running" or row["turn_completed"] is not None
                            or row["node_status"] not in {"running", "waiting"}
                            or row["node_completed"] is not None):
                        raise _Unavailable("provider_unverified", "stale", observed)
                    if row["status"] == "waiting" or row["waiting"]:
                        status = "waiting_approval" if row["approval"] else "waiting_input" if row["waiting"] else "waiting"
                    else:
                        if row["session_status"] == "waiting" or row["node_status"] == "waiting":
                            raise _Unavailable("provider_unverified", "stale", observed)
                        status = "running"
                    items.append(_item(row["thread_id"], row["title"], row["provider"], status))
                for row in agents:
                    # App-owned children have their own durable runs above. The
                    # parent subagent record can remain running after a child ends.
                    if row["completed_at"] is not None or row["deleted_at"] is not None:
                        continue
                    if (not row["child_exists"] or row["child_run_status"] is None
                            or (row["child_run_status"] in {"running", "waiting"}
                                and row["child_thread_id"] not in seen_threads)):
                        raise _Unavailable("inconsistent_state", "stale", observed)
                items.sort(key=lambda item: item["status"] != "running")
                return {"status": "live", "working": sum(item["status"] == "running" for item in items),
                        "threads": items[:MAX_ITEMS], "observedAt": _iso(observed),
                        "note": "Verified T3 execution." if items else "No working T3 threads."}
        except sqlite3.Error as error:
            if getattr(error, "sqlite_errorcode", None) == sqlite3.SQLITE_INTERRUPT:
                raise _Unavailable("read_bound", "stale") from None
            if getattr(error, "sqlite_errorcode", None) in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
                raise _Unavailable("database_busy") from None
            raise _Unavailable("database_unreadable") from None
        except OSError:
            raise _Unavailable("database_unreadable") from None
