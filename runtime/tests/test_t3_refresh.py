"""T3 usage refresh against a fake loopback WebSocket server, never real T3."""

import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import time
import unittest

from turzx_studio import t3_refresh
from turzx_studio.t3_refresh import RefreshError, UsageRefresher, request_usage_scan
from turzx_studio.usage import UsageCollector


class FakeT3:
    """Accept one connection, record the request and reply as instructed."""

    def __init__(self, reply=None, status=101, ping=False, chatter=False):
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.port = self.server.getsockname()[1]
        self.reply, self.status, self.ping, self.chatter = reply, status, ping, chatter
        self.headers, self.request, self.pong = None, None, None
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def close(self):
        self.server.close()
        self.thread.join(5)

    @staticmethod
    def exact(conn, size):
        data = b""
        while len(data) < size:
            chunk = conn.recv(size - len(data))
            if not chunk:
                raise EOFError
            data += chunk
        return data

    def client_frame(self, conn):
        first, second = self.exact(conn, 2)
        size = second & 0x7F
        if size == 126:
            size = struct.unpack("!H", self.exact(conn, 2))[0]
        mask = self.exact(conn, 4)
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self.exact(conn, size)))
        return first & 0x0F, payload

    @staticmethod
    def frame(opcode, payload, final=True):
        size = len(payload)
        head = struct.pack("!BB", (0x80 if final else 0) | opcode, size) if size < 126 else \
            struct.pack("!BBH", (0x80 if final else 0) | opcode, 126, size)
        return head + payload

    def serve(self):
        try:
            conn, _ = self.server.accept()
        except OSError:
            return
        with conn:
            head = b""
            while b"\r\n\r\n" not in head:
                head += conn.recv(1)
            self.headers = head.decode()
            key = next(line.split(":", 1)[1].strip() for line in self.headers.split("\r\n")
                       if line.lower().startswith("sec-websocket-key"))
            if self.status != 101:
                conn.sendall(f"HTTP/1.1 {self.status} No\r\nContent-Length: 0\r\n\r\n".encode())
                return
            accept = base64.b64encode(hashlib.sha1((key + t3_refresh.WS_GUID).encode()).digest()).decode()
            conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
            _, payload = self.client_frame(conn)
            self.request = json.loads(payload)
            if self.ping:
                conn.sendall(self.frame(0x9, b"hi"))
                self.pong = self.client_frame(conn)
            if self.chatter:
                conn.sendall(self.frame(0x1, json.dumps({"_tag": "Chunk", "requestId": "other"}).encode()))
            body = json.dumps(self.reply).encode()
            # Fragment the reply to exercise continuation frames.
            conn.sendall(self.frame(0x1, body[:10], final=False) + self.frame(0x0, body[10:]))
            try:
                self.client_frame(conn)
            except (EOFError, OSError):
                pass


SUCCESS = {"_tag": "Exit", "requestId": "1", "exit": {"_tag": "Success", "value": {"buckets": []}}}


class RequestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / ".t3/userdata").mkdir(parents=True)
        self.token = self.home / "state/t3-usage-token"
        self.token.parent.mkdir()
        self.token.write_text("secret-token\n")
        self.token.chmod(0o600)

    def runtime(self, origin):
        (self.home / ".t3/userdata/server-runtime.json").write_text(json.dumps({"origin": origin}))

    def serve(self, **kwargs):
        server = FakeT3(**kwargs)
        self.addCleanup(server.close)
        self.runtime(f"http://127.0.0.1:{server.port}")
        return server

    def test_success_sends_bearer_and_rolling_window_summary_request(self):
        server = self.serve(reply=SUCCESS, ping=True, chatter=True)
        request_usage_scan(self.home, self.token, now=lambda: 1792500000)
        server.thread.join(5)
        self.assertIn("GET /ws?orchestrationProtocol=2 ", server.headers)
        self.assertIn("Authorization: Bearer secret-token\r\n", server.headers)
        self.assertEqual(server.request, {"_tag": "Request", "id": "1", "tag": "server.getUsageSummary", "headers": [],
                                          "payload": {"sinceDay": "2026-09-20", "untilDay": "2026-10-20", "timeZone": "UTC"}})
        self.assertEqual(server.pong, (0xA, b"hi"))

    def test_historical_window_covers_rolling_start_across_year_boundary(self):
        server = self.serve(reply=SUCCESS)
        now = datetime(2026, 1, 15, 23, 59, tzinfo=timezone.utc).timestamp()
        request_usage_scan(self.home, self.token, now=lambda: now)
        server.thread.join(5)
        self.assertEqual(server.request["payload"], {
            "sinceDay": "2025-12-16", "untilDay": "2026-01-15", "timeZone": "UTC"})

    def test_failures_map_to_fixed_codes(self):
        cases = [
            (dict(status=401), "t3_token_rejected"),
            (dict(reply={"_tag": "Exit", "requestId": "1", "exit": {"_tag": "Failure", "cause": {
                "_tag": "Fail", "error": {"_tag": "EnvironmentAuthorizationError"}}}}), "t3_token_scope"),
            (dict(reply={"_tag": "Exit", "requestId": "1", "exit": {"_tag": "Failure", "cause": {
                "_tag": "Fail", "error": {"_tag": "UsageReadError", "reason": "scanFailed"}}}}), "t3_usage_scan_failed"),
        ]
        for kwargs, code in cases:
            with self.subTest(code=code):
                self.serve(**kwargs)
                with self.assertRaises(RefreshError) as raised:
                    request_usage_scan(self.home, self.token)
                self.assertEqual(raised.exception.code, code)
                self.assertNotIn("secret", str(raised.exception))

    def test_never_sends_token_off_loopback(self):
        for origin in ("http://192.168.1.4:3773", "https://127.0.0.1:3773", "http://example.com:3773"):
            with self.subTest(origin=origin):
                self.runtime(origin)
                with self.assertRaises(RefreshError) as raised:
                    request_usage_scan(self.home, self.token)
                self.assertEqual(raised.exception.code, "t3_server_not_loopback")

    def test_token_and_server_problems(self):
        self.runtime("http://127.0.0.1:1")
        with self.assertRaises(RefreshError) as raised:
            request_usage_scan(self.home, self.token)
        self.assertEqual(raised.exception.code, "t3_unreachable")
        self.token.chmod(0o644)
        with self.assertRaises(RefreshError) as raised:
            request_usage_scan(self.home, self.token)
        self.assertEqual(raised.exception.code, "t3_token_permissions")
        self.token.unlink()
        with self.assertRaises(RefreshError) as raised:
            request_usage_scan(self.home, self.token)
        self.assertEqual(raised.exception.code, "t3_token_missing")
        (self.home / ".t3/userdata/server-runtime.json").unlink()
        with self.assertRaises(RefreshError) as raised:
            request_usage_scan(self.home, self.token)
        self.assertEqual(raised.exception.code, "t3_server_unknown")

    def test_timeout_when_server_never_replies(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        self.addCleanup(server.close)
        self.runtime(f"http://127.0.0.1:{server.getsockname()[1]}")
        original = t3_refresh.REQUEST_SECONDS
        t3_refresh.REQUEST_SECONDS = 0.3
        self.addCleanup(setattr, t3_refresh, "REQUEST_SECONDS", original)
        with self.assertRaises(RefreshError) as raised:
            request_usage_scan(self.home, self.token)
        self.assertEqual(raised.exception.code, "t3_timeout")


class RefresherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.token = Path(self.temp.name) / "t3-usage-token"
        self.now = 1000.0
        self.calls, self.expired = [], []
        self.failure = None
        self.release = threading.Event()
        self.release.set()

        def request(home, token):
            self.calls.append(token)
            self.release.wait(5)
            if self.failure:
                raise RefreshError(self.failure)

        self.refresher = UsageRefresher(Path(self.temp.name), self.token, lambda: self.expired.append(True),
                                        clock=lambda: self.now, request=request, persistence_seconds=0)

    def settle(self):
        deadline = time.monotonic() + 5
        while self.refresher._running and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(self.refresher._running, "refresh thread did not finish")

    def test_missing_token_stays_idle(self):
        self.assertFalse(self.refresher.poke())
        self.assertEqual(self.calls, [])
        self.assertEqual(self.refresher.status()["error"], "t3_token_missing")

    def test_rate_limits_runs_once_and_expires_collector(self):
        self.token.write_text("t")
        self.release.clear()
        self.assertTrue(self.refresher.poke())
        self.assertFalse(self.refresher.poke())
        self.release.set()
        self.settle()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.expired, [True])
        self.assertIsNone(self.refresher.status()["error"])
        self.assertIsNotNone(self.refresher.status()["refreshedAt"])
        self.now += t3_refresh.REFRESH_SECONDS - 1
        self.assertFalse(self.refresher.poke())
        self.now += 1
        self.assertTrue(self.refresher.poke())
        self.settle()
        self.assertEqual(len(self.calls), 2)

    def test_rejected_token_backs_off_and_keeps_collector(self):
        self.token.write_text("t")
        self.failure = "t3_token_rejected"
        self.assertTrue(self.refresher.poke())
        self.settle()
        self.assertEqual(self.refresher.status()["error"], "t3_token_rejected")
        self.assertEqual(self.expired, [])
        self.now += t3_refresh.REFRESH_SECONDS
        self.assertFalse(self.refresher.poke())
        self.now += t3_refresh.REJECTED_BACKOFF_SECONDS
        self.assertTrue(self.refresher.poke())
        self.settle()


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.base = self.home / ".t3/userdata"
        self.base.mkdir(parents=True)
        self.token = self.home / "t3-usage-token"
        self.token.write_text("test-token")
        self.now = datetime(2026, 10, 20, 12, tzinfo=timezone.utc).timestamp()
        mountinfo = self.home / "mountinfo"
        mountinfo.write_text("")
        self.collector = UsageCollector(self.home, clock=lambda: self.now, mountinfo_path=mountinfo)
        self.done = threading.Event()

    def write_cache(self, path, total):
        row = [int(self.now * 1000), 0, 0, total, 0, 0, 0, 0, None, None, 0]
        document = {"version": int(path.stem[-1]), "models": ["model-a"], "sessions": ["session-a"],
                    "files": {"session.jsonl": {"p": "codex", "s": 10, "m": self.now * 1000,
                                               "r": [row], "t": []}}}
        replacement = path.with_suffix(".tmp")
        replacement.write_text(json.dumps(document))
        if path.exists():
            stamp = path.stat().st_mtime_ns
            os.utime(replacement, ns=(stamp, stamp))
        replacement.replace(path)

    def start_refresh(self, request, *, sleep=time.sleep, persistence_seconds=1):
        def expire():
            self.collector.expire()
            self.done.set()

        self.refresher = UsageRefresher(self.home, self.token, expire, request=request,
                                        sleep=sleep, persistence_seconds=persistence_seconds)
        self.assertTrue(self.refresher.poke())

    def settle(self):
        self.assertTrue(self.done.wait(2), "collector was not expired")
        deadline = time.monotonic() + 2
        while self.refresher._running and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(self.refresher._running)
        self.assertIsNone(self.refresher.status()["error"])

    def test_delayed_replacement_expires_collector_after_new_totals_are_persisted(self):
        for version in (7, 6, 5, None):
            with self.subTest(initial_version=version):
                for path in self.base.glob("*.json"):
                    path.unlink()
                self.collector = UsageCollector(self.home, clock=lambda: self.now,
                                                mountinfo_path=self.home / "mountinfo")
                self.done.clear()
                path = self.base / f"usage-scan-cache-v{version or 7}.json"
                if version is not None:
                    self.write_cache(path, 10)
                old_total = 10 if version is not None else None
                self.assertEqual(self.collector.snapshot()["providers"]["codex"]["total"], old_total)
                waiting = []

                def delayed_write(seconds):
                    waiting.append((threading.current_thread().name, self.done.is_set(),
                                    self.collector.snapshot()["providers"]["codex"]["total"]))
                    self.write_cache(path, 20)

                self.start_refresh(lambda home, token: None, sleep=delayed_write)
                self.settle()
                self.assertEqual(waiting, [("t3-usage-refresh", False, old_total)])
                self.assertEqual(self.collector.snapshot()["providers"]["codex"]["total"], 20)

    def test_new_v7_cache_supersedes_existing_fallback_before_expiring(self):
        self.write_cache(self.base / "usage-scan-cache-v6.json", 10)
        self.assertEqual(self.collector.snapshot()["providers"]["codex"]["total"], 10)
        self.start_refresh(lambda home, token: self.write_cache(self.base / "usage-scan-cache-v7.json", 20))
        self.settle()
        self.assertEqual(self.collector.snapshot()["providers"]["codex"]["total"], 20)

    def test_unchanged_cache_still_expires_collector_after_timeout(self):
        self.write_cache(self.base / "usage-scan-cache-v7.json", 10)
        self.collector.snapshot()
        waits = []

        def sleep(seconds):
            waits.append(seconds)
            time.sleep(seconds)

        self.start_refresh(lambda home, token: None, sleep=sleep, persistence_seconds=0.02)
        self.settle()
        self.assertTrue(waits)
        self.assertLessEqual(sum(waits), 0.02)
        self.assertFalse(self.collector.snapshot()["cached"])


if __name__ == "__main__":
    unittest.main()
