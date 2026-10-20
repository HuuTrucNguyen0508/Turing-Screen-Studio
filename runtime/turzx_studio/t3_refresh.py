"""Ask the local T3 server to rescan usage so its scan cache stays current.

T3 rescans transcripts and rewrites usage-scan-cache-v7.json only when a client
requests server.getUsageSummary, which normally happens only while its Usage
page is open. This sends that request over T3's loopback WebSocket with a
diagnostics:read bearer token. The reply is discarded; UsageCollector reads the
rewritten cache file. Requests run on a short-lived thread so a slow scan never
blocks the panel loop.
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import threading
import time
from typing import Callable
from urllib.parse import urlsplit

from .usage import SCAN_CACHE_FILES

REFRESH_SECONDS = 60
REJECTED_BACKOFF_SECONDS = 900
CONNECT_SECONDS = 2.0
REQUEST_SECONDS = 60.0
PERSISTENCE_SECONDS = 5.0
PERSISTENCE_POLL_SECONDS = 0.1
MAX_HEADER_BYTES = 16 * 1024
MAX_MESSAGE_BYTES = 8 * 1024 * 1024
MAX_SMALL_FILE_BYTES = 64 * 1024
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
REQUEST_ID = "1"


class RefreshError(Exception):
    """A fixed code; never contains token, path or server text."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def token_path(state_dir: Path) -> Path:
    return state_dir / "t3-usage-token"


def _small_file(path: Path, missing: str, *, private: bool = False) -> bytes:
    try:
        with path.open("rb") as handle:
            if private and os.fstat(handle.fileno()).st_mode & 0o077:
                raise RefreshError("t3_token_permissions")
            data = handle.read(MAX_SMALL_FILE_BYTES + 1)
    except OSError:
        raise RefreshError(missing) from None
    if len(data) > MAX_SMALL_FILE_BYTES:
        raise RefreshError(missing)
    return data


def _server(home: Path) -> tuple[str, int]:
    try:
        runtime = json.loads(_small_file(home / ".t3/userdata/server-runtime.json", "t3_server_unknown"))
        origin = urlsplit(runtime["origin"])
        host, port = origin.hostname, origin.port
    except (ValueError, KeyError, TypeError):
        raise RefreshError("t3_server_unknown") from None
    # The bearer token must never leave this machine.
    if origin.scheme != "http" or host not in LOOPBACK or not port:
        raise RefreshError("t3_server_not_loopback")
    return host, port


def _token(path: Path) -> str:
    token = _small_file(path, "t3_token_missing", private=True).decode("ascii", "replace").strip()
    if not token or any(ch.isspace() or not ch.isprintable() for ch in token):
        raise RefreshError("t3_token_invalid")
    return token


class _Socket:
    def __init__(self, sock: socket.socket, deadline: float):
        self.sock, self.deadline, self.buffer = sock, deadline, b""

    def _fill(self) -> None:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise RefreshError("t3_timeout")
        self.sock.settimeout(remaining)
        try:
            chunk = self.sock.recv(65536)
        except socket.timeout:
            raise RefreshError("t3_timeout") from None
        except OSError:
            raise RefreshError("t3_connection_lost") from None
        if not chunk:
            raise RefreshError("t3_connection_lost")
        self.buffer += chunk

    def exact(self, size: int) -> bytes:
        while len(self.buffer) < size:
            self._fill()
        data, self.buffer = self.buffer[:size], self.buffer[size:]
        return data

    def headers(self) -> bytes:
        while b"\r\n\r\n" not in self.buffer:
            if len(self.buffer) > MAX_HEADER_BYTES:
                raise RefreshError("t3_bad_handshake")
            self._fill()
        head, self.buffer = self.buffer.split(b"\r\n\r\n", 1)
        return head

    def send_frame(self, opcode: int, payload: bytes) -> None:
        size = len(payload)
        if size < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | size)
        elif size < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, size)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, size)
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.settimeout(max(0.1, self.deadline - time.monotonic()))
        try:
            self.sock.sendall(header + mask + masked)
        except OSError:
            raise RefreshError("t3_connection_lost") from None

    def message(self) -> bytes:
        """Return one complete text message, answering pings on the way."""
        parts, total = [], 0
        while True:
            first, second = self.exact(2)
            opcode, final = first & 0x0F, first & 0x80
            size = second & 0x7F
            if second & 0x80:
                raise RefreshError("t3_bad_frame")
            if size == 126:
                size = struct.unpack("!H", self.exact(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self.exact(8))[0]
            total += size
            if total > MAX_MESSAGE_BYTES:
                raise RefreshError("t3_response_too_large")
            payload = self.exact(size)
            if opcode == 0x9:
                self.send_frame(0xA, payload)
            elif opcode == 0x8:
                raise RefreshError("t3_connection_closed")
            elif opcode in (0x1, 0x2, 0x0):
                parts.append(payload)
                if final:
                    return b"".join(parts)
            elif opcode != 0xA:
                raise RefreshError("t3_bad_frame")


def _exit(message: bytes) -> dict | None:
    try:
        value = json.loads(message)
    except (ValueError, RecursionError):
        raise RefreshError("t3_bad_response") from None
    for item in value if isinstance(value, list) else [value]:
        if isinstance(item, dict) and item.get("_tag") == "Exit" and item.get("requestId") == REQUEST_ID:
            return item.get("exit") if isinstance(item.get("exit"), dict) else {}
    return None


def request_usage_scan(home: Path, token_file: Path, *, now: Callable[[], float] = time.time) -> None:
    """Request a T3 usage rescan; persistence may finish later. Raises RefreshError."""
    host, port = _server(home)
    token = _token(token_file)
    deadline = time.monotonic() + REQUEST_SECONDS
    try:
        sock = socket.create_connection((host, port), timeout=CONNECT_SECONDS)
    except OSError:
        raise RefreshError("t3_unreachable") from None
    with sock:
        stream = _Socket(sock, deadline)
        key = base64.b64encode(os.urandom(16)).decode()
        handshake = (f"GET /ws?orchestrationProtocol=2 HTTP/1.1\r\nHost: {host}:{port}\r\n"
                     f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                     f"Sec-WebSocket-Version: 13\r\nAuthorization: Bearer {token}\r\n\r\n")
        sock.settimeout(CONNECT_SECONDS)
        try:
            sock.sendall(handshake.encode())
        except OSError:
            raise RefreshError("t3_unreachable") from None
        lines = stream.headers().decode("latin-1").split("\r\n")
        status = lines[0].split(" ")
        if len(status) < 2 or status[1] != "101":
            code = status[1] if len(status) > 1 else ""
            raise RefreshError("t3_token_rejected" if code in ("401", "403") else "t3_bad_handshake")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        fields = {name.strip().lower(): value.strip() for name, _, value in (line.partition(":") for line in lines[1:])}
        if fields.get("sec-websocket-accept") != accept:
            raise RefreshError("t3_bad_handshake")
        # T3 selects transcripts by mtime relative to sinceDay.
        day = datetime.fromtimestamp(now(), timezone.utc).date()
        since_day = day - timedelta(days=30)
        request = {"_tag": "Request", "id": REQUEST_ID, "tag": "server.getUsageSummary",
                   "payload": {"sinceDay": since_day.isoformat(), "untilDay": day.isoformat(), "timeZone": "UTC"},
                   "headers": []}
        stream.send_frame(0x1, json.dumps(request).encode())
        while True:
            result = _exit(stream.message())
            if result is not None:
                break
        try:
            stream.send_frame(0x8, struct.pack("!H", 1000))
        except RefreshError:
            pass
    if result.get("_tag") != "Success":
        text = json.dumps(result)
        raise RefreshError("t3_token_scope" if "EnvironmentAuthorizationError" in text else "t3_usage_scan_failed")


def _scan_cache_identity(home: Path) -> tuple[Path, int, int, int] | None:
    for name in SCAN_CACHE_FILES:
        path = home / ".t3/userdata" / name
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        except OSError:
            return None
        return path, stat.st_mtime_ns, stat.st_size, stat.st_ino
    return None


class UsageRefresher:
    """Rate-limited background trigger; poke() never blocks the caller."""

    def __init__(self, home: Path, token_file: Path, on_success: Callable[[], None] | None = None, *,
                 clock: Callable[[], float] = time.monotonic,
                 request: Callable[[Path, Path], None] = request_usage_scan,
                 persistence_seconds: float = PERSISTENCE_SECONDS,
                 sleep: Callable[[float], None] = time.sleep):
        self.home, self.token_file = home, token_file
        self.on_success = on_success
        self.clock, self.request = clock, request
        self.persistence_seconds, self.sleep = persistence_seconds, sleep
        self._lock = threading.Lock()
        self._running = False
        self._next = 0.0
        self.error: str | None = None
        self.refreshed_at: float | None = None

    def status(self) -> dict:
        with self._lock:
            return {"error": self.error,
                    "refreshedAt": None if self.refreshed_at is None else
                    datetime.fromtimestamp(self.refreshed_at, timezone.utc).isoformat().replace("+00:00", "Z")}

    def poke(self) -> bool:
        with self._lock:
            now = self.clock()
            if self._running or now < self._next:
                return False
            if not self.token_file.exists():
                # Not configured: stay idle without logging an attempt.
                self.error, self._next = "t3_token_missing", now + REFRESH_SECONDS
                return False
            self._running, self._next = True, now + REFRESH_SECONDS
        threading.Thread(target=self._run, name="t3-usage-refresh", daemon=True).start()
        return True

    def _run(self) -> None:
        error = None
        try:
            previous = _scan_cache_identity(self.home)
            self.request(self.home, self.token_file)
            # T3 returns before its detached cache write completes.
            deadline = time.monotonic() + self.persistence_seconds
            while _scan_cache_identity(self.home) == previous:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.sleep(min(PERSISTENCE_POLL_SECONDS, remaining))
        except RefreshError as failure:
            error = failure.code
        except Exception:
            error = "t3_refresh_failed"
        if error is None and self.on_success is not None:
            try:
                self.on_success()
            except Exception:
                error = "t3_refresh_callback_failed"
        with self._lock:
            self._running = False
            self.error = error
            if error is None:
                self.refreshed_at = time.time()
            elif error in ("t3_token_rejected", "t3_token_scope", "t3_token_permissions", "t3_token_invalid"):
                self._next = max(self._next, self.clock() + REJECTED_BACKOFF_SECONDS)
