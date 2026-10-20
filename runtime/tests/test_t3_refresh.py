"""T3 usage refresh against a fake loopback WebSocket server, never real T3."""

import base64
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

    def test_success_sends_bearer_and_today_summary_request(self):
        server = self.serve(reply=SUCCESS, ping=True, chatter=True)
        request_usage_scan(self.home, self.token, now=lambda: 1792500000)
        server.thread.join(5)
        self.assertIn("GET /ws?orchestrationProtocol=2 ", server.headers)
        self.assertIn("Authorization: Bearer secret-token\r\n", server.headers)
        self.assertEqual(server.request, {"_tag": "Request", "id": "1", "tag": "server.getUsageSummary", "headers": [],
                                          "payload": {"sinceDay": "2026-10-20", "untilDay": "2026-10-20", "timeZone": "UTC"}})
        self.assertEqual(server.pong, (0xA, b"hi"))

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
                                        clock=lambda: self.now, request=request)

    def settle(self):
        deadline = time.monotonic() + 5
        while self.refresher._running and time.monotonic() < deadline:
            time.sleep(0.01)

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


if __name__ == "__main__":
    unittest.main()
