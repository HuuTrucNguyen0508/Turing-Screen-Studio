"""Bounded, local-only usage observations. No network, subprocesses or writes."""

from __future__ import annotations

import copy
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import threading
import time
from typing import Callable

from .mounted_storage import collect_mounted_storage


CACHE_SECONDS = 60
STALE_SECONDS = 300
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_FILES = 4096
MAX_ROWS = 100_000
MAX_MODELS = 1024
MAX_SESSIONS = 20_000
MAX_RATES = 20_000
MAX_SCAN_ENTRIES = 4096
MAX_SCAN_DIRS = 256
MAX_QUOTA_FILES = 16
MAX_TAIL_BYTES = 128 * 1024
MAX_SCAN_BYTES = 2 * 1024 * 1024
MAX_LINE_BYTES = 64 * 1024
MAX_DB_ROWS = 256
MAX_DB_PAYLOAD_BYTES = 16 * 1024
MAX_DB_SECONDS = 0.25
PROVIDERS = ("codex", "claude")
TOKEN_FIELDS = ("input", "cacheRead", "cacheWrite", "output", "reasoning")
UNPRICEABLE = {"<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"}


def _number(value: object) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def _iso(seconds: float | None) -> str | None:
    if seconds is None:
        return None
    try:
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError):
        return None


def _timestamp(value: object) -> float | None:
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.timestamp() if parsed.tzinfo is not None else None
    except (ValueError, OverflowError):
        return None


def _freshness(source: str, observed: float | None, now: float, errors: list[str], max_age: int = STALE_SECONDS) -> dict:
    stale = observed is None or observed > now or now - observed > max_age or bool(errors)
    return {"source": source, "observedAt": _iso(observed), "readAt": _iso(now),
            "stale": stale, "status": "unavailable" if observed is None else "stale" if stale else "cached",
            "errors": list(errors)}


def _read_json(path: Path) -> tuple[dict, float]:
    with path.open("rb") as handle:
        if os.fstat(handle.fileno()).st_size > MAX_JSON_BYTES:
            raise ValueError("size")
        raw = handle.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise ValueError("size")
        observed = os.fstat(handle.fileno()).st_mtime
    document = json.loads(raw)
    if not isinstance(document, dict):
        raise ValueError("shape")
    return document, observed


def _decode_row(row: object, models: list, sessions: list) -> tuple | None:
    # T3 v5 serializeFile/decodeScanCache in src/usage/usageScanCache.ts.
    # r contains complete-line records; t contains separately parsed tail records.
    if not isinstance(row, list) or len(row) != 11:
        return None
    stamp, model, session, *rest = row
    if not _number(stamp) or _iso(stamp / 1000) is None:
        return None
    if type(model) is not int or not 0 <= model < len(models):
        return None
    if type(session) is not int or not 0 <= session < len(sessions):
        return None
    if not isinstance(models[model], str) or not 0 < len(models[model]) <= 128:
        return None
    if not isinstance(sessions[session], str) or len(sessions[session]) > 256:
        return None
    tokens = rest[:5]
    if any(type(value) is not int or not 0 <= value <= 2**53 - 1 for value in tokens):
        return None
    key, cost, speed = rest[5:]
    if key is not None and (not isinstance(key, str) or len(key) > 1024):
        return None
    if cost is not None and not _number(cost):
        return None
    if type(speed) is not int or speed not in (0, 1, 2):
        return None
    if tokens[4] > tokens[3]:
        return None
    return stamp / 1000, models[model], sessions[session], tuple(tokens), key, cost, speed


def _token_rates(entry: dict, suffix: str = "", standard: tuple | None = None) -> tuple | None:
    values = [entry.get("input_cost_per_token" + suffix), entry.get("output_cost_per_token" + suffix)]
    if not all(_number(value) for value in values):
        return None
    for index, field in enumerate(("cache_read_input_token_cost", "cache_creation_input_token_cost"), 2):
        value = entry.get(field + suffix)
        if not _number(value):
            # Verified T3 readTokenRates fallback, not a model-family guess.
            value = standard[index] / standard[0] * values[0] if standard and standard[0] > 0 else values[0]
        values.append(value)
    return tuple(values)


def _rate_table(document: dict) -> dict:
    table = {}
    for name, entry in document.items():
        if not isinstance(name, str) or len(name) > 256 or not isinstance(entry, dict):
            continue
        standard = _token_rates(entry)
        if standard is None:
            continue
        specific = entry.get("provider_specific_entry")
        multiplier = specific.get("fast") if isinstance(specific, dict) else None
        fast = tuple(value * multiplier for value in standard) if _number(multiplier) and multiplier > 0 else _token_rates(entry, "_priority", standard)
        table[name.strip().lower()] = (standard, fast, _token_rates(entry, "_ultrafast", standard))
    # T3 only aliases qualified entries when all candidates agree.
    aliases = {}
    for name, rates in table.items():
        bare = name.rsplit("/", 1)[-1]
        if bare != name and bare not in table:
            if bare not in aliases:
                aliases[bare] = rates
            elif aliases[bare] != rates:
                aliases[bare] = None
    table.update({name: rates for name, rates in aliases.items() if rates is not None})
    return table


def _price(row: tuple, rates: dict) -> tuple[float | None, str]:
    _, model, _, tokens, _, reported, speed = row
    if reported is not None:
        return reported, "reported"
    name = model.strip().lower().split("[", 1)[0]
    if name.rsplit("/", 1)[-1] in UNPRICEABLE or name not in rates:
        return None, "unavailable"
    rate = rates[name][speed] or rates[name][0]
    uncached, read, write, output, _ = tokens
    cost = uncached * rate[0] + read * rate[2] + write * rate[3] + output * rate[1]
    return (cost, "estimate") if math.isfinite(cost) else (None, "unavailable")


def _empty_totals() -> dict:
    return {**dict.fromkeys(TOKEN_FIELDS, 0), "cache": 0, "total": 0,
            "records": 0, "costUSD": None, "costKind": "unavailable",
            "knownCostUSD": 0.0, "reportedRecords": 0, "estimatedRecords": 0, "unpricedRecords": 0}


def _add(totals: dict, row: tuple, cost: float | None, kind: str) -> None:
    for field, value in zip(TOKEN_FIELDS, row[3]):
        totals[field] += value
    totals["cache"] += row[3][1] + row[3][2]
    totals["total"] += sum(row[3][:4])
    totals["records"] += 1
    if cost is None:
        totals["unpricedRecords"] += 1
    else:
        totals["knownCostUSD"] += cost
        totals["reportedRecords" if kind == "reported" else "estimatedRecords"] += 1


def _finish(totals: dict) -> dict:
    if totals["records"] and not totals["unpricedRecords"] and math.isfinite(totals["knownCostUSD"]):
        totals["costUSD"] = totals["knownCostUSD"]
        totals["costKind"] = "estimate" if totals["estimatedRecords"] else "reported"
    if not math.isfinite(totals["knownCostUSD"]):
        totals["knownCostUSD"] = None
    return totals


class UsageCollector:
    """Reuse one instance; snapshot returns a detached JSON-safe dictionary.

    clock returns Unix seconds. All token totals describe the current UTC day
    in T3's saved local scan cache, including both Codex homes. Quota describes
    only .codex-pro and cached Claude notices, not a live account probe.
    """

    def __init__(self, home: Path | None = None, clock: Callable[[], float] = time.time, *,
                 mountinfo_path: Path | str = "/proc/self/mountinfo",
                 disk_usage: Callable | None = None):
        self.home = (Path(home) if home is not None else Path.home()).expanduser().absolute()
        self.clock = clock
        self.mountinfo_path = Path(mountinfo_path)
        self.disk_usage = disk_usage
        self._lock = threading.Lock()
        self._snapshot = None
        self._refreshed = None
        self._token_previous = {}
        self._limits = {provider: {} for provider in PROVIDERS}
        self._tails = {}

    def snapshot(self) -> dict:
        with self._lock:
            now = float(self.clock())
            day = datetime.fromtimestamp(now, timezone.utc).date().isoformat()
            cached = (self._snapshot is not None and self._refreshed <= now < self._refreshed + CACHE_SECONDS
                      and self._snapshot["scope"]["day"] == day)
            if not cached:
                self._snapshot = self._collect(now, day)
                self._refreshed = now
            result = copy.deepcopy(self._snapshot)
            result["servedAt"] = _iso(now)
            result["cached"] = cached
            # Staleness and elapsed resets can change during the 60-second cache.
            for provider in PROVIDERS:
                for component, fresh in result["providers"][provider]["freshness"].items():
                    observed = _timestamp(fresh["observedAt"])
                    age = 86400 if component == "pricing" else STALE_SECONDS
                    fresh["stale"] |= observed is None or observed > now or now - observed > age
                    if fresh["stale"] and observed is not None:
                        fresh["status"] = "stale"
                for limit in result["providers"][provider]["limits"]:
                    observed, reset = _timestamp(limit["observedAt"]), _timestamp(limit["resetsAt"])
                    limit["stale"] = (observed is None or observed > now or now - observed > STALE_SECONDS
                                      or reset is not None and now >= reset
                                      or result["providers"][provider]["freshness"]["limits"]["stale"])
                if any(limit["stale"] for limit in result["providers"][provider]["limits"]):
                    result["providers"][provider]["freshness"]["limits"].update(stale=True, status="stale")
            return result

    def _collect(self, now: float, day: str) -> dict:
        base = self.home / ".t3/userdata"
        rate_errors = []
        rates, rates_at = {}, None
        try:
            raw, _ = _read_json(base / "usage-model-rates.json")
            document = raw.get("document")
            if not isinstance(document, dict) or len(document) > MAX_RATES or not _number(raw.get("fetchedAtMs")):
                raise ValueError("rates")
            rates_at = raw["fetchedAtMs"] / 1000
            if _iso(rates_at) is None:
                raise ValueError("timestamp")
            rates = _rate_table(document)
        except (OSError, ValueError, RecursionError):
            rate_errors.append("pricing_cache_unavailable")
            rates_at = None
        totals, token_freshness = self._tokens(base, rates, now, day)
        codex_errors = self._codex_limits(now)
        claude_errors = self._claude_limits(base / "statev2.sqlite", now)
        providers = {}
        for name, limit_errors in (("codex", codex_errors), ("claude", claude_errors)):
            limits = sorted(self._limits[name].values(), key=lambda limit: limit["label"])
            observed = max((_timestamp(limit["observedAt"]) for limit in limits), default=None)
            freshness = {
                "tokens": token_freshness[name],
                "pricing": _freshness("t3_cached_litellm_rates", rates_at, now, rate_errors, 86400),
                "limits": _freshness("codex_pro_token_count" if name == "codex" else "t3_claude_system_notice",
                                     observed, now, limit_errors),
            }
            providers[name] = {**totals[name], "limits": copy.deepcopy(limits), "freshness": freshness,
                               "source": "t3_usage_scan_cache_v5",
                               "errors": sorted(set(itertools.chain.from_iterable(part["errors"] for part in freshness.values())))}
        return {"contractVersion": 1, "readAt": _iso(now), "scope": {"period": "today", "day": day,
                "timeZone": "UTC", "accounts": "all_local_t3_cached_sources", "quotaAccount": "codex-pro"},
                "providers": providers, "storage": self._storage(now),
                "mountedStorage": collect_mounted_storage(now, self.mountinfo_path, self.disk_usage)}

    def _tokens(self, base: Path, rates: dict, now: float, day: str) -> tuple[dict, dict]:
        errors, observed = [], None
        available = set()
        totals = {name: _empty_totals() for name in PROVIDERS}
        models = {name: {} for name in PROVIDERS}
        latest = {name: None for name in PROVIDERS}
        duplicates = {name: 0 for name in PROVIDERS}
        try:
            raw, observed = _read_json(base / "usage-scan-cache-v5.json")
            names, sessions, files = raw.get("models"), raw.get("sessions"), raw.get("files")
            if (raw.get("version") != 5 or not isinstance(names, list) or len(names) > MAX_MODELS
                    or not isinstance(sessions, list) or len(sessions) > MAX_SESSIONS or not isinstance(files, dict)
                    or len(files) > MAX_FILES):
                raise ValueError("cache_schema")
            seen, count = set(), 0
            for entry in files.values():
                if not isinstance(entry, dict) or entry.get("p") not in PROVIDERS:
                    continue
                provider = entry["p"]
                if not isinstance(entry.get("r"), list) or not isinstance(entry.get("t", []), list):
                    raise ValueError("usage_cache_invalid_file")
                available.add(provider)
                occurrences = {}
                for serialized in itertools.chain(entry["r"], entry.get("t", [])):
                    count += 1
                    if count > MAX_ROWS:
                        raise ValueError("row_bound")
                    row = _decode_row(serialized, names, sessions)
                    if row is None:
                        raise ValueError("usage_cache_invalid_row")
                    stamp, model, session, tokens, key, _, _ = row
                    # Codex moved rollouts: preserve identical occurrences within
                    # a file, dedupe the same occurrence across copied files.
                    if provider == "codex" and session:
                        signature = (provider, session, stamp, model, tokens)
                        occurrence = occurrences.get(signature, 0) + 1
                        occurrences[signature] = occurrence
                        key = (signature, occurrence)
                    elif key is not None:
                        key = (provider, key)
                    if key is not None:
                        if key in seen:
                            duplicates[provider] += 1
                            continue
                        seen.add(key)
                    if datetime.fromtimestamp(stamp, timezone.utc).date().isoformat() != day or stamp > now:
                        continue
                    latest[provider] = max(latest[provider] or stamp, stamp)
                    bucket = models[provider].setdefault(model, _empty_totals())
                    cost, kind = _price(row, rates)
                    _add(totals[provider], row, cost, kind)
                    _add(bucket, row, cost, kind)
        except (OSError, ValueError, RecursionError):
            errors.append("usage_cache_unavailable_or_bound_exceeded")
            available.clear()
        errors = sorted(set(errors))
        freshness = {}
        for name in PROVIDERS:
            if name in available:
                value = {**_finish(totals[name]), "perModel": [{"model": model, **_finish(bucket)} for model, bucket in sorted(models[name].items())],
                         "latestRecordAt": _iso(latest[name]), "duplicatesDropped": duplicates[name]}
                self._token_previous[name] = (day, copy.deepcopy(value), observed)
            else:
                prior = self._token_previous.get(name)
                if prior and prior[0] == day:
                    value, observed_provider = copy.deepcopy(prior[1]), prior[2]
                else:
                    value = {field: None for field in _empty_totals()}
                    value.update(costKind="unavailable", perModel=[], latestRecordAt=None, duplicatesDropped=0)
                    observed_provider = None
                totals[name] = value
                freshness[name] = _freshness("t3_usage_scan_cache_v5", observed_provider, now,
                                             errors or ["usage_cache_provider_missing"])
                continue
            totals[name] = value
            freshness[name] = _freshness("t3_usage_scan_cache_v5", observed, now, errors)
        return totals, freshness

    def _remember(self, provider: str, key: str, limit: dict) -> None:
        previous = self._limits[provider].get(key)
        if previous is None or limit["observedAt"] > previous["observedAt"]:
            self._limits[provider][key] = limit

    def _quota_files(self) -> tuple[list, list[str]]:
        root = self.home / ".codex-pro/sessions"
        pending, found, errors = [root], [], []
        visited = entries = 0
        while pending and visited < MAX_SCAN_DIRS and entries < MAX_SCAN_ENTRIES:
            directory = pending.pop()
            visited += 1
            try:
                with os.scandir(directory) as iterator:
                    for entry in iterator:
                        entries += 1
                        if entries > MAX_SCAN_ENTRIES:
                            break
                        if entry.is_dir(follow_symlinks=False):
                            pending.append(Path(entry.path))
                        elif entry.name.endswith(".jsonl") and entry.is_file(follow_symlinks=False):
                            stat = entry.stat(follow_symlinks=False)
                            found.append((stat.st_mtime_ns, Path(entry.path), stat))
            except OSError:
                errors.append("codex_quota_directory_unavailable")
        if pending or entries >= MAX_SCAN_ENTRIES:
            errors.append("codex_quota_directory_bound_reached")
        found.sort(key=lambda item: (item[0], str(item[1])), reverse=True)
        return found[:MAX_QUOTA_FILES], errors

    def _codex_limits(self, now: float) -> list[str]:
        files, errors = self._quota_files()
        byte_budget = MAX_SCAN_BYTES
        keep = {}
        for _, path, stat in files:
            previous = self._tails.get(path)
            identity = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
            if (previous and previous["identity"] == identity
                    and (previous.get("retryAt") is None or previous["retryAt"] > now)):
                keep[path] = previous
                continue
            if byte_budget <= 0:
                errors.append("codex_quota_byte_bound_reached")
                break
            try:
                with path.open("rb") as handle:
                    current = os.fstat(handle.fileno())
                    size = current.st_size
                    head = handle.read(min(64, size, byte_budget))
                    byte_budget -= len(head)
                    head_hash = hashlib.sha256(head).hexdigest()
                    resumed = bool(previous and previous["identity"][:2] == identity[:2]
                                   and previous["identity"][2] < size and previous.get("guardLength", 0)
                                   and previous.get("headHash") == head_hash)
                    if resumed:
                        length = previous["guardLength"]
                        if byte_budget < length:
                            resumed = False
                        else:
                            handle.seek(previous["offset"] - length)
                            guard = handle.read(length)
                            byte_budget -= len(guard)
                            resumed = len(guard) == length and hashlib.sha256(guard).hexdigest() == previous["guardHash"]
                    start = max(0, size - min(MAX_TAIL_BYTES, byte_budget))
                    resumed = resumed and previous["offset"] >= start
                    if resumed:
                        start = previous["offset"]
                    handle.seek(start)
                    data = handle.read(min(MAX_TAIL_BYTES, byte_budget))
                byte_budget -= len(data)
                if start > 0 and not resumed:
                    newline = data.find(b"\n")
                    start += newline + 1 if newline >= 0 else len(data)
                    data = data[newline + 1:] if newline >= 0 else b""
                complete = data.rfind(b"\n") + 1
                offset = start + complete
                guard = data[:complete][-64:]
                keep[path] = {"identity": identity, "offset": offset, "guardLength": len(guard),
                              "guardHash": hashlib.sha256(guard).hexdigest(), "headHash": head_hash}
                for line in data[:complete].splitlines():
                    if len(line) > MAX_LINE_BYTES:
                        errors.append("codex_quota_line_bound_reached")
                        continue
                    if b'"rate_limits"' not in line:
                        continue
                    try:
                        event = json.loads(line)
                        if not isinstance(event, dict):
                            continue
                        payload = event.get("payload")
                        if (event.get("type") != "event_msg" or not isinstance(payload, dict)
                                or payload.get("type") != "token_count"):
                            continue
                        stamp, limits = _timestamp(event.get("timestamp")), payload.get("rate_limits")
                        if stamp is None or not isinstance(limits, dict):
                            continue
                        if stamp > now:
                            # A writer can append between snapshot's clock read
                            # and this read. Revisit that unchanged file later.
                            keep[path]["retryAt"] = min(stamp, keep[path].get("retryAt", stamp))
                            continue
                        for key in ("primary", "secondary"):
                            window = limits.get(key)
                            if not isinstance(window, dict):
                                continue
                            used, duration, reset = window.get("used_percent"), window.get("window_minutes"), window.get("resets_at")
                            # This source is Pro only. Never manufacture a session bar.
                            if not _number(used) or used > 100 or not _number(duration) or duration < 10080:
                                continue
                            reset = reset if _number(reset) and _iso(reset) is not None else None
                            self._remember("codex", key, {"id": key, "label": "Weekly" if duration == 10080 else f"{duration:g}-minute window",
                                           "usedPercent": used, "remainingPercent": 100 - used,
                                           "resetsAt": _iso(reset), "resetKind": "reported", "observedAt": _iso(stamp),
                                           "stale": True, "source": "codex_pro_token_count", "windowMinutes": duration})
                    except (ValueError, RecursionError):
                        errors.append("codex_quota_invalid_event")
            except OSError:
                errors.append("codex_quota_file_unavailable")
        self._tails = keep
        if not self._limits["codex"]:
            errors.append("codex_quota_unavailable")
        return sorted(set(errors))

    def _claude_limits(self, path: Path, now: float) -> list[str]:
        errors = []
        try:
            with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.1)) as connection:
                connection.execute("PRAGMA query_only = ON")
                deadline = time.monotonic() + MAX_DB_SECONDS
                connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
                # Only system notices, never prompts, replies or tool payloads.
                rows = connection.execute(
                    "SELECT updated_at, payload_json FROM orchestration_v2_projection_turn_items "
                    "WHERE type = 'system_notice' AND length(CAST(payload_json AS BLOB)) <= ? "
                    "AND payload_json LIKE '%Claude usage limit reached%' "
                    "ORDER BY updated_at DESC LIMIT ?", (MAX_DB_PAYLOAD_BYTES, MAX_DB_ROWS)).fetchall()
                if len(rows) == MAX_DB_ROWS:
                    errors.append("claude_notice_row_bound_reached")
                for updated, raw in rows:
                    try:
                        payload = json.loads(raw)
                        if not isinstance(payload, dict):
                            continue
                        stamp = _timestamp(payload.get("startedAt")) or _timestamp(updated)
                        if stamp is None or stamp > now:
                            continue
                        message = payload.get("message") or payload.get("title")
                        if not isinstance(message, str):
                            continue
                        matched = re.fullmatch(
                            r"Claude usage limit reached\. This turn is paused until the 5-hour limit resets in "
                            r"(?:(\d{1,3})h )?(\d{1,3})m\.", message)
                        if matched is None:
                            continue
                        minutes = int(matched[1] or 0) * 60 + int(matched[2])
                        if not 0 <= minutes <= 300:
                            continue
                        self._remember("claude", "five_hour", {"id": "five_hour", "label": "5-hour",
                                       "usedPercent": 100, "remainingPercent": 0,
                                       "resetsAt": _iso(stamp + minutes * 60), "resetKind": "notice_relative_estimate",
                                       "observedAt": _iso(stamp), "stale": True,
                                       "source": "t3_claude_system_notice", "windowMinutes": 300})
                    except (ValueError, RecursionError):
                        errors.append("claude_notice_invalid")
        except (OSError, ValueError, sqlite3.Error):
            errors.append("claude_notice_database_unavailable")
        if not self._limits["claude"]:
            errors.append("claude_quota_unavailable")
        return sorted(set(errors))

    @staticmethod
    def _storage(now: float) -> dict:
        try:
            usage = shutil.disk_usage("/")
            if usage.total <= 0:
                raise ValueError("storage_total")
            gib = 1024**3
            return {"mount": "/", "totalGiB": usage.total / gib, "usedGiB": usage.used / gib,
                    "freeGiB": usage.free / gib, "usedPercent": usage.used / usage.total * 100,
                    "freeKind": "available_to_unprivileged_process", "observedAt": _iso(now),
                    "stale": False, "source": "shutil.disk_usage", "errors": []}
        except (OSError, ValueError):
            return {"mount": "/", "totalGiB": None, "usedGiB": None, "freeGiB": None, "usedPercent": None,
                    "freeKind": "available_to_unprivileged_process", "observedAt": None,
                    "stale": True, "source": "shutil.disk_usage", "errors": ["root_storage_unavailable"]}
