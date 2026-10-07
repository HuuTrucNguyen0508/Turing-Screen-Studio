"""HTTP and storage safety checks. Run with unittest from the repository root."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from http.client import HTTPConnection
from io import BytesIO
import json
import os
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))

import server
from turzx_studio.layout import parse_layout, revision, serialize_layout
from turzx_studio.storage import PaletteWatcher, Paths, atomic_write


class StorageTests(unittest.TestCase):
    def test_atomic_replace_failure_preserves_destination_and_removes_temp(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "layout.json"
            atomic_write(path, b"original")
            with patch("turzx_studio.storage.os.replace", side_effect=OSError("replace failed")):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    atomic_write(path, b"replacement")
            self.assertEqual(path.read_bytes(), b"original")
            self.assertEqual(list(Path(directory).iterdir()), [path])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_atomic_flush_failure_never_replaces_destination(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "layout.json"
            atomic_write(path, b"original")
            with patch("turzx_studio.storage.os.fsync", side_effect=OSError("flush failed")):
                with self.assertRaisesRegex(OSError, "flush failed"):
                    atomic_write(path, b"replacement")
            self.assertEqual(path.read_bytes(), b"original")
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_paths_use_shared_runtime_and_state_locations(self):
        with patch.dict(os.environ, {"XDG_RUNTIME_DIR": "/run/example"}):
            paths = Paths()
            self.assertEqual(paths.layout, Path.home() / ".local/share/turzx-studio/layout.json")
            self.assertEqual(paths.status, Path("/run/example/turzx-studio/status.json"))
            self.assertEqual(paths.frame, Path("/run/example/turzx-studio/frame.png"))
        explicit = Paths("/state", "/runtime")
        self.assertEqual(explicit.layout, Path("/state/layout.json"))
        self.assertEqual(explicit.status, Path("/runtime/status.json"))

    def test_palette_keeps_last_good_on_invalid_and_missing_scheme(self):
        sample = json.loads((RUNTIME.parent / "public/sample-layout.json").read_text())
        with TemporaryDirectory() as directory:
            path = Path(directory) / "scheme.json"
            watcher = PaletteWatcher(path)
            self.assertIsNone(watcher.poll())
            self.assertIsNotNone(watcher.error)
            atomic_write(path, json.dumps(sample["palette"]).encode())
            first = watcher.poll()
            self.assertIsNone(watcher.error)
            first["primary"] = "#ffffff"
            self.assertEqual(watcher.poll()["primary"], sample["palette"]["primary"])
            atomic_write(path, b'{"colours":{}}')
            self.assertEqual(watcher.poll()["primary"], sample["palette"]["primary"])
            self.assertIsNotNone(watcher.error)
            path.unlink()
            self.assertEqual(watcher.poll()["primary"], sample["palette"]["primary"])
            self.assertIsNotNone(watcher.error)
            changed = deepcopy(sample["palette"])
            changed["primary"] = "#abcdef"
            atomic_write(path, json.dumps(changed).encode())
            self.assertEqual(watcher.poll()["primary"], "#abcdef")
            self.assertIsNone(watcher.error)


class ProcessTests(unittest.TestCase):
    @staticmethod
    def write_stat(root: Path, pid: int, ticks: str, state: str = "S"):
        directory = root / str(pid)
        directory.mkdir(exist_ok=True)
        # Field 3 is state, fields 4..21 are filler, and field 22 is starttime.
        fields = [state, *(["0"] * 18), ticks, "0", "0"]
        (directory / "stat").write_text(f"{pid} (worker (one) name) {' '.join(fields)}")

    def test_pid_start_ticks_prevent_reuse_and_reject_zombies(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_stat(root, 123, "987654")
            self.assertEqual(server.process_start(123, root), "987654")
            self.assertTrue(server.runtime_is_running({"pid": 123, "processStart": "987654"}, root))
            self.assertTrue(server.runtime_is_running({"pid": 123, "processStart": 987654}, root))
            self.assertFalse(server.runtime_is_running({"pid": 123, "processStart": "999999"}, root))
            self.assertFalse(server.runtime_is_running({"pid": 123}, root))
            self.assertFalse(server.runtime_is_running({"pid": True, "processStart": "987654"}, root))
            self.assertFalse(server.runtime_is_running({"pid": 124, "processStart": "987654"}, root))
            self.write_stat(root, 123, "987654", "Z")
            self.assertFalse(server.runtime_is_running({"pid": 123, "processStart": "987654"}, root))
            (root / "123/stat").write_text("malformed")
            self.assertIsNone(server.process_start(123, root))

    def test_usb_presence_reads_only_sysfs_identification(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            device = root / "1-2"
            device.mkdir()
            (device / "idVendor").write_text("1cbe\n")
            (device / "idProduct").write_text("0080\n")
            self.assertTrue(server.usb_present(root))
            (device / "idProduct").write_text("0090\n")
            self.assertFalse(server.usb_present(root))


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.paths = Paths(self.root / "state", self.root / "runtime")
        self.dist = self.root / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text("<!doctype html><title>Studio fixture</title>")
        (self.dist / "assets").mkdir()
        (self.dist / "assets/app.js").write_text("window.studio = true;")
        self.scheme = self.root / "scheme.json"
        self.app = server.StudioApplication(self.paths, dist=self.dist, scheme=self.scheme)
        self.httpd = server.StudioHTTPServer(self.app, 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.host = f"127.0.0.1:{self.httpd.server_port}"
        self.origin = f"http://{self.host}"
        self.document = self.app.layout()["document"]

    def stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def request(self, method, path, body=None, headers=None):
        supplied = {"Host": self.host, **(headers or {})}
        connection = HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=10)
        try:
            connection.request(method, path, body=body, headers=supplied)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def post(self, path, document, headers=None):
        return self.request("POST", path, json.dumps(document).encode(),
                            {"Content-Type": "application/json", "Origin": self.origin, **(headers or {})})

    def assert_json_error(self, response, expected):
        status, headers, body = response
        self.assertEqual(status, expected, body)
        self.assertTrue(headers["Content-Type"].startswith("application/json"))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIn("error", json.loads(body))
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_removed_ai_endpoints_return_404_without_changing_saved_layout(self):
        original = self.paths.layout.read_bytes()
        for path in ("/api/ai", "/api/ai/jobs/test-job"):
            for method in ("GET", "HEAD"):
                with self.subTest(method=method, path=path):
                    response = self.request(method, path)
                    self.assertEqual(response[0], 404)
                    self.assertTrue(response[1]["Content-Type"].startswith("application/json"))
        for path in ("/api/ai/jobs", "/api/ai/jobs/test-job/cancel"):
            with self.subTest(method="POST", path=path):
                self.assert_json_error(self.post(path, {}), 404)
        self.assertEqual(self.paths.layout.read_bytes(), original)

    def test_seed_is_live_canonical_and_never_overwrites_existing_file(self):
        self.assertEqual(self.document["paletteMode"], "live")
        for widget in self.document["widgets"]:
            self.assertEqual(widget["settings"]["source"], widget["id"])
        self.assertEqual(self.paths.layout.read_text(), serialize_layout(self.document))
        self.assertEqual(stat.S_IMODE(self.paths.layout.stat().st_mode), 0o600)
        atomic_write(self.paths.layout, b"invalid existing file")
        server.StudioApplication(self.paths, dist=self.dist, scheme=self.scheme)
        self.assertEqual(self.paths.layout.read_bytes(), b"invalid existing file")
        self.assert_json_error(self.request("GET", "/api/layout"), 422)
        self.assert_json_error(self.post("/api/layout", self.document, {"If-Match": "old"}), 422)
        self.assertEqual(self.paths.layout.read_bytes(), b"invalid existing file")

    def test_get_save_and_missing_or_stale_revision(self):
        status, headers, body = self.request("GET", "/api/layout")
        saved = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(headers["ETag"], f'"{saved["revision"]}"')
        self.assertEqual(saved["revision"], revision(saved["document"]))
        self.assert_json_error(self.post("/api/layout", self.document), 428)
        changed = deepcopy(self.document)
        changed["widgets"][0]["x"] += 1
        status, _, body = self.post("/api/layout", changed, {"If-Match": headers["ETag"]})
        self.assertEqual(status, 200, body)
        updated = json.loads(body)
        self.assertNotEqual(updated["revision"], saved["revision"])
        self.assert_json_error(self.post("/api/layout", self.document, {"If-Match": saved["revision"]}), 409)
        self.assertEqual(parse_layout(self.paths.layout.read_text()), changed)
        changed["name"] = "Second save"
        self.assertEqual(self.post("/api/layout", changed, {"If-Match": updated["revision"]})[0], 200)

    def test_live_endpoints_and_preview_mode_are_read_only_and_explicit(self):
        previous = self.paths.layout.read_bytes()
        status, _, body = self.request('GET', '/api/live')
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(body)['available'])
        self.assert_json_error(self.post('/api/preview?mode=live', self.document), 503)
        for query in ('mode=other', 'mode=live&mode=sample', 'mode=', 'unknown=yes'):
            self.assert_json_error(self.post('/api/preview?' + query, self.document), 400)
        status, headers, body = self.post('/api/preview?mode=sample', self.document)
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'image/png')
        self.assertEqual(self.paths.layout.read_bytes(), previous)
        self.assertFalse(self.paths.older_configs.exists())

    def test_concurrent_writers_with_same_revision_have_one_winner(self):
        current = self.app.layout()["revision"]
        barrier = threading.Barrier(2)

        def save(name):
            document = deepcopy(self.document)
            document["name"] = name
            barrier.wait(timeout=5)
            return name, self.post("/api/layout", document, {"If-Match": current})

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(save, ("writer one", "writer two")))
        self.assertEqual(sorted(result[1][0] for result in results), [200, 409])
        winner = next(name for name, response in results if response[0] == 200)
        self.assertEqual(self.app.layout()["document"]["name"], winner)

    def test_failed_save_reports_json_and_keeps_old_file(self):
        original = self.paths.layout.read_bytes()
        changed = deepcopy(self.document)
        changed["name"] = "Unsaved"
        with patch("server.atomic_write", side_effect=OSError("disk full")):
            response = self.post("/api/layout", changed, {"If-Match": revision(self.document)})
        self.assert_json_error(response, 500)
        self.assertEqual(self.paths.layout.read_bytes(), original)

    def test_history_reads_exact_old_layout_and_cannot_escape_archive(self):
        changed = deepcopy(self.document)
        changed['name'] = 'Replacement'
        status, _, body = self.post('/api/layout', changed, {'If-Match': revision(self.document)})
        self.assertEqual(status, 200)
        identifier = json.loads(body)['archive']['id']
        status, _, body = self.request('GET', '/api/history')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['archives'][0]['id'], identifier)
        status, _, body = self.request('GET', '/api/history/' + identifier)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['document'], self.document)
        self.assert_json_error(self.request('GET', '/api/history/../layout.json'), 404)
        self.assert_json_error(self.request('GET', '/api/history/original-dashboard'), 404)

    def test_panel_geometry_requires_exact_dimensions_and_integer_bounds(self):
        mutations = (
            lambda doc: doc["canvas"].update(width=1281),
            lambda doc: doc["canvas"].update(height=801),
            lambda doc: doc["widgets"][0].update(x=1.5),
            lambda doc: doc["widgets"][0].update(x=True),
            lambda doc: doc["widgets"][0].update(x=-1),
            lambda doc: doc["widgets"][0].update(width=0),
            lambda doc: doc["widgets"][0].update(x=1200),
        )
        original = self.paths.layout.read_bytes()
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                document = deepcopy(self.document)
                mutate(document)
                self.assert_json_error(self.post("/api/layout", document,
                                               {"If-Match": revision(self.document)}), 422)
                self.assertEqual(self.paths.layout.read_bytes(), original)

    def test_strict_json_and_request_size(self):
        for body in (b"{", b'{"version":1,"version":1}', b'{"bad":NaN}',
                     b'{"bad":Infinity}', b'{"bad":1e999}', b'"\xff"'):
            with self.subTest(body=body):
                self.assert_json_error(self.request("POST", "/api/preview", body,
                                                   {"Content-Type": "application/json"}), 400)
        self.assert_json_error(self.post("/api/preview", []), 422)
        self.assert_json_error(self.request("POST", "/api/preview", b"{}"), 415)
        self.assert_json_error(self.request("POST", "/api/preview", b"{}",
                                           {"Content-Type": "application/json",
                                            "Content-Length": str(server.MAX_BODY_BYTES + 1)}), 413)

    def test_host_and_origin_reject_dns_rebinding_and_cross_origin_requests(self):
        for host in ("evil.example", f"evil.example:{self.httpd.server_port}", "127.0.0.1",
                     f"127.0.0.1:{self.httpd.server_port}.evil.example"):
            self.assert_json_error(self.request("GET", "/api/layout", headers={"Host": host}), 403)
        for origin in ("null", "https://evil.example", self.origin + ".evil.example",
                       f"http://localhost:{self.httpd.server_port}"):
            self.assert_json_error(self.post("/api/layout", self.document,
                                           {"Origin": origin, "If-Match": revision(self.document)}), 403)
        host = f"localhost:{self.httpd.server_port}"
        self.assertEqual(self.request("GET", "/api/layout", headers={"Host": host, "Origin": f"http://{host}"})[0], 200)
        connection = HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=10)
        try:
            connection.putrequest("GET", "/api/layout", skip_host=True)
            connection.putheader("Host", self.host)
            connection.putheader("Host", "evil.example")
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            json.loads(response.read())
        finally:
            connection.close()

    def test_preview_is_deterministic_nonpanel_and_never_reads_runtime_or_usb(self):
        document = deepcopy(self.document)
        document["paletteMode"] = "saved"
        document["canvas"] = {"width": 96, "height": 64}
        document["widgets"] = []
        original = self.paths.layout.read_bytes()
        with patch("server.usb_present", side_effect=AssertionError("preview inspected USB")), \
                patch("server.runtime_is_running", side_effect=AssertionError("preview inspected runtime")), \
                patch.object(self.app.renderer, "render", wraps=self.app.renderer.render) as render:
            first = self.post("/api/preview", document)
            second = self.post("/api/preview", document)
            self.assertEqual(first[0], 200, first[2])
            self.assertEqual(first[1]["Content-Type"], "image/png")
            self.assertTrue(first[2].startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertEqual(first[2], second[2])
            self.assertIsNone(render.call_args.kwargs["stats"])
        from PIL import Image
        with Image.open(BytesIO(first[2])) as image:
            self.assertEqual(image.size, (96, 64))
        self.assertEqual(self.paths.layout.read_bytes(), original)
        self.assertFalse(self.paths.runtime_dir.exists())

    def test_oversized_preview_rejects_before_renderer_allocation(self):
        document = deepcopy(self.document)
        document["canvas"] = {"width": 4001, "height": 4000}
        document["widgets"] = []
        with patch.object(self.app.renderer, "render", side_effect=AssertionError("allocated too early")) as render:
            self.assert_json_error(self.post("/api/preview", document), 422)
            render.assert_not_called()

    def test_live_palette_preview_and_last_good_palette_endpoint(self):
        colors = deepcopy(self.document["palette"])
        colors["background"] = "#123456"
        atomic_write(self.scheme, json.dumps(colors).encode())
        status, _, body = self.request("GET", "/api/palette")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"palette": colors, "error": None})
        document = deepcopy(self.document)
        document["canvas"] = {"width": 96, "height": 64}
        document["widgets"] = []
        with patch.object(self.app.renderer, "render", wraps=self.app.renderer.render) as render:
            self.assertEqual(self.post("/api/preview", document)[0], 200)
            self.assertEqual(render.call_args.kwargs["palette"], colors)
        atomic_write(self.scheme, b"broken")
        result = json.loads(self.request("GET", "/api/palette")[2])
        self.assertEqual(result["palette"], colors)
        self.assertIsNotNone(result["error"])

    def test_status_validates_process_identity_and_saved_requested_revision(self):
        with patch("server.usb_present", return_value=False):
            result = json.loads(self.request("GET", "/api/status")[2])
            self.assertFalse(result["runtimeRunning"])
            self.assertFalse(result["usbPresent"])
            self.assertEqual(result["requestedRevision"], revision(self.document))
            ticks = server.process_start(os.getpid())
            self.assertIsNotNone(ticks)
            atomic_write(self.paths.status, json.dumps({"pid": os.getpid(), "processStart": ticks,
                                                       "appliedRevision": "old"}).encode())
            result = json.loads(self.request("GET", "/api/status")[2])
            self.assertTrue(result["runtimeRunning"])
            self.assertEqual(result["appliedRevision"], "old")
            atomic_write(self.paths.status, json.dumps({"pid": os.getpid(), "processStart": "0"}).encode())
            self.assertFalse(json.loads(self.request("GET", "/api/status")[2])["runtimeRunning"])
            atomic_write(self.paths.status, b"invalid")
            result = json.loads(self.request("GET", "/api/status")[2])
            self.assertFalse(result["runtimeRunning"])
            self.assertIn("error", result)

    def test_frame_and_unknown_api_have_no_spa_fallback(self):
        self.assert_json_error(self.request("GET", "/api/frame"), 404)
        frame = b"\x89PNG\r\n\x1a\nfixture"
        atomic_write(self.paths.frame, frame)
        status, headers, body = self.request("GET", "/api/frame")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(body, frame)
        self.assert_json_error(self.request("GET", "/api/missing", headers={"Accept": "text/html"}), 404)
        self.assert_json_error(self.request("OPTIONS", "/api/layout"), 405)

    def test_static_files_traversal_symlinks_and_reasonable_spa_fallback(self):
        (self.root / "secret.txt").write_text("private")
        (self.dist / "secret-link.txt").symlink_to(self.root / "secret.txt")
        for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/secret-link.txt", "/..%5csecret.txt"):
            self.assert_json_error(self.request("GET", path), 404)
        self.assertEqual(self.request("GET", "/assets/app.js")[0], 200)
        self.assertEqual(self.request("GET", "/editor", headers={"Accept": "text/html"})[0], 200)
        self.assert_json_error(self.request("GET", "/missing.js", headers={"Accept": "text/html"}), 404)
        self.assert_json_error(self.request("GET", "/assets/missing", headers={"Accept": "text/html"}), 404)
        self.app.dist = self.root / "missing-dist"
        response = self.request("GET", "/")
        self.assert_json_error(response, 503)
        self.assertIn("pnpm build", json.loads(response[2])["error"])
        self.assertEqual(self.request("GET", "/api/layout")[0], 200)


if __name__ == "__main__":
    unittest.main()
