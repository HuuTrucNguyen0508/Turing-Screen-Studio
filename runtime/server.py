"""Loopback-only Studio HTTP server, with no sensor or USB ownership."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import math
import mimetypes
from pathlib import Path
import re
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit

from turzx_studio.layout import parse_layout, revision, serialize_layout, validate_layout
from turzx_studio.renderer import LayoutRenderer
from turzx_studio.storage import PaletteWatcher, Paths, atomic_write
from turzx_studio.archives import archive_layout, layout_write_lock, list_archives, read_archive
from turzx_studio.layout_library import (
    LayoutLibrary, LibraryTooLarge, active_id, library_revision, select_entry, validate_library,
)
from turzx_studio.widget_templates import WidgetTemplates, validate_templates, templates_revision
from turzx_studio.usage import UsageCollector
from turzx_studio.usage_display import USAGE_SOURCES, UsageStats
from turzx_studio.live import MAX_AGE, source_diagnostics, snapshot_stats, validate_snapshot

ROOT = Path(__file__).resolve().parent.parent
MAX_BODY_BYTES = 1024 * 1024
MAX_PREVIEW_PIXELS = 16_000_000


class APIError(Exception):
    def __init__(self, status: int, message: str, **details: object) -> None:
        super().__init__(message)
        self.status = status
        self.details = details


def strict_json(data: bytes) -> object:
    def pairs(items: list) -> dict:
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"duplicate JSON object key: {key}")
            result[key] = value
        return result

    def constant(value: str) -> None:
        raise ValueError(f"invalid JSON number: {value}")

    def decimal(value: str) -> float:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("JSON numbers must be finite")
        return number

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                          parse_constant=constant, parse_float=decimal)
    except (ValueError, RecursionError) as error:
        raise APIError(400, f"Invalid JSON: {error}") from error


def process_start(pid: int, proc_root: Path = Path("/proc")) -> str | None:
    """Read Linux start ticks, allowing spaces and parentheses in comm."""
    if type(pid) is not int or pid <= 0:
        return None
    try:
        text = (proc_root / str(pid) / "stat").read_text(encoding="utf-8")
        prefix, delimiter, fields = text.rpartition(")")
        values = fields.split()
        if not delimiter or not prefix.startswith(f"{pid} ("):
            return None
        if values[0] in ("Z", "X", "x"):
            return None
        ticks = values[19]  # field 22; values starts at field 3 (state).
        return ticks if ticks.isascii() and ticks.isdecimal() else None
    except (OSError, ValueError, IndexError):
        return None


def runtime_is_running(status: dict, proc_root: Path = Path("/proc")) -> bool:
    pid = status.get("pid")
    expected = status.get("processStart")
    if type(expected) is int:
        expected = str(expected)
    if not isinstance(expected, str) or not expected.isascii() or not expected.isdecimal():
        return False
    actual = process_start(pid, proc_root)
    return actual is not None and actual == expected


def usb_present(root: Path = Path("/sys/bus/usb/devices")) -> bool:
    """Read only sysfs identification files; never open a USB device."""
    try:
        devices = list(root.iterdir())
    except OSError:
        return False
    for device in devices:
        try:
            vendor = (device / "idVendor").read_text(encoding="ascii").strip().lower()
            product = (device / "idProduct").read_text(encoding="ascii").strip().lower()
            if (vendor, product) == ("1cbe", "0080"):
                return True
        except (OSError, ValueError):
            continue
    return False


def read_bounded(path: Path) -> bytes:
    with path.open("rb") as stream:
        data = stream.read(MAX_BODY_BYTES + 1)
    if len(data) > MAX_BODY_BYTES:
        raise ValueError("file exceeds the 1 MB limit")
    return data


class StudioApplication:
    def __init__(self, paths: Paths | None = None, *, dist: str | Path | None = None,
                 font_dir: str | Path | None = None, scheme: str | Path | None = None,
                 sample: str | Path | None = None) -> None:
        self.paths = paths if paths is not None else Paths()
        self.widget_templates = WidgetTemplates(self.paths)
        self.dist = (Path(dist).expanduser() if dist is not None else ROOT / "dist").resolve()
        self.palette = PaletteWatcher(scheme if scheme is not None else
                                      Path.home() / ".local/state/caelestia/scheme.json")
        self.renderer = LayoutRenderer(font_dir=Path(font_dir).expanduser() if font_dir is not None
                                       else Path.home() / "Documents/turing-smart-screen-python/res/fonts")
        self.layout_lock = threading.RLock()
        self.library = LayoutLibrary(self.paths, ROOT / 'public/layout-presets.json')
        self.render_lock = threading.Lock()
        self.palette_lock = threading.Lock()
        self.seed_error: str | None = None
        self.usage = UsageCollector()
        with self.layout_lock:
            # lexists behavior preserves broken symlinks too, rather than seeding over them.
            if self.paths.layout.exists() or self.paths.layout.is_symlink():
                return
            try:
                document = parse_layout(read_bounded(Path(sample) if sample is not None else
                                                    ROOT / "public/sample-layout.json").decode("utf-8"), panel=True)
                document["paletteMode"] = "live"
                for widget in document["widgets"]:
                    if widget["type"] == "metric" and widget["id"] in ("cpu", "gpu", "memory"):
                        widget["settings"]["source"] = widget["id"]
                    elif widget["type"] == "weather":
                        widget["settings"]["source"] = "weather"
                atomic_write(self.paths.layout, serialize_layout(document).encode("utf-8"))
            except (OSError, ValueError) as error:
                self.seed_error = f"Cannot create the initial Studio layout: {error}"

    def _read_layout(self) -> dict:
        try:
            return parse_layout(read_bounded(self.paths.layout).decode("utf-8"), panel=True)
        except (OSError, ValueError) as error:
            raise APIError(422, self.seed_error or f"Cannot load saved layout: {error}") from error

    def layout(self) -> dict:
        with self.layout_lock:
            document = self._read_layout()
            return {"document": document, "revision": revision(document)}

    def save(self, raw: object, if_match: str | None) -> dict:
        with self.layout_lock, layout_write_lock(self.paths):
            return self._save_locked(raw, if_match)

    def _save_locked(self, raw: object, if_match: str | None) -> dict:
        """Shared save transaction; caller holds layout_lock and layout_write_lock."""
        if if_match is None:
            raise APIError(428, "Saving requires the current layout revision in If-Match")
        try:
            document = validate_layout(raw, panel=True)
            encoded = serialize_layout(document).encode("utf-8")
        except (ValueError, RecursionError) as error:
            raise APIError(422, str(error)) from error
        if len(encoded) > MAX_BODY_BYTES:
            raise APIError(413, "Canonical layout exceeds the 1 MB limit")
        try:
            previous = read_bounded(self.paths.layout)
            current = revision(parse_layout(previous.decode('utf-8'), panel=True))
        except (OSError, ValueError) as error:
            raise APIError(422, f"Cannot load saved layout: {error}") from error
        if if_match not in (current, f'"{current}"'):
            raise APIError(409, "Saved layout changed; reload it before saving", revision=current)
        try:
            runtime = strict_json(read_bounded(self.paths.status))
        except (OSError, ValueError, APIError):
            runtime = {}
        if isinstance(runtime, dict) and runtime_is_running(runtime):
            supported = runtime.get('supportedWidgetTypes', ['metric', 'weather'])
            if (not isinstance(supported, list) or
                    any(widget['type'] not in supported for widget in document['widgets'])):
                raise APIError(409, 'The panel runtime needs an update before saving these widgets. Restart turzx-dashboard.service with the current Studio adapter; your draft and saved layout are intact.')
            design_types = runtime.get('supportedDesignTypes', [])
            if any('design' in widget and (not isinstance(design_types, list) or widget['type'] not in design_types) for widget in document['widgets']):
                raise APIError(409, 'The panel runtime needs an update before saving widget designs. Restart turzx-dashboard.service with the current Studio adapter; your draft and saved layout are intact.')
            if any('trend' in widget['settings'] for widget in document['widgets']) and runtime.get('supportedTrendWidgets') is not True:
                raise APIError(409, 'The panel runtime needs an update before saving trends. Restart turzx-dashboard.service with the current Studio adapter; your draft and saved layout are intact.')
            storage_views = runtime.get('supportedStorageViews', [])
            if any(widget['type'] == 'storage' and ('grouping' in widget['settings'] or 'mounts' in widget['settings']) and
                   (not isinstance(storage_views, list) or widget['settings'].get('grouping', 'partitions') not in storage_views)
                   for widget in document['widgets']):
                raise APIError(409, 'The panel runtime needs an update before saving storage views. Restart turzx-dashboard.service with the current Studio adapter; your draft and saved layout are intact.')
            styles = runtime.get('supportedGaugeStyles', [])
            usage_sources = runtime.get('supportedUsageSources', [])
            requested_sources = [widget['settings'].get('source') for widget in document['widgets']
                                 if widget['settings'].get('source') in USAGE_SOURCES]
            if requested_sources and (not isinstance(usage_sources, list) or
                    any(source not in usage_sources for source in requested_sources)):
                raise APIError(409, 'The panel runtime needs an update before saving usage or storage widgets. Restart turzx-dashboard.service with the current Studio adapter; your draft and saved layout are intact.')
            requested_styles = [widget['settings']['style'] for widget in document['widgets']
                                if widget['type'] == 'gauge' and 'style' in widget['settings']]
            if requested_styles and (not isinstance(styles, list) or
                    any(style not in styles for style in requested_styles)):
                raise APIError(409, 'The panel runtime needs an update before saving these gauge styles. Restart turzx-dashboard.service with the current Studio adapter; your draft and saved layout are intact.')
        try:
            if revision(document) == current:
                return {"document": document, "revision": current, "archive": None}
            archive = archive_layout(self.paths, previous)
            atomic_write(self.paths.layout, encoded)
        except OSError as error:
            raise APIError(500, f"Cannot archive the previous layout or save the replacement: {error}") from error
        return {"document": document, "revision": revision(document), "archive": archive}

    def widgets(self) -> dict:
        with self.layout_lock, layout_write_lock(self.paths):
            try:
                document = self.widget_templates.read()
            except (OSError, ValueError, RecursionError) as error:
                raise APIError(422, f'Cannot read custom widgets: {error}. Preserve widgets.json before repairing it.') from error
            return {**document, 'revision': templates_revision(document)}

    def save_widgets(self, raw: object, if_match: str | None) -> dict:
        if if_match is None:
            raise APIError(428, 'Saving custom widgets requires their revision in If-Match')
        try:
            document = validate_templates(raw)
        except (ValueError, RecursionError) as error:
            raise APIError(422, str(error)) from error
        with self.layout_lock, layout_write_lock(self.paths):
            try:
                stored = self.widget_templates.read()
            except (OSError, ValueError) as error:
                raise APIError(422, f'Cannot read custom widgets: {error}') from error
            previous = {**stored, 'revision': templates_revision(stored)}
            if if_match not in (previous['revision'], f'"{previous["revision"]}"'):
                raise APIError(409, 'Custom widgets changed elsewhere. Refresh before saving; your draft is intact.', revision=previous['revision'])
            try:
                self.widget_templates.write(document)
            except OSError as error:
                raise APIError(500, f'Cannot preserve custom widgets or save their replacement: {error}') from error
            return {**document, 'revision': templates_revision(document)}

    def _read_library(self, current: dict, *, initialize: bool = False) -> dict:
        try:
            return self.library.read()
        except FileNotFoundError as error:
            if not initialize:
                raise APIError(422, 'Saved layouts are missing. Open the saved dashboard library or run pnpm layout saved to initialize it.') from error
            try:
                library = self.library.initial(current)
                self.library.write(library)
                return library
            except (OSError, ValueError, RecursionError) as error:
                raise APIError(500, f'Cannot initialize saved layouts: {error}') from error
        except (OSError, ValueError, RecursionError) as error:
            raise APIError(422, f'Cannot load saved layouts: {error}. Preserve layouts.json and repair the saved dashboard library before switching.') from error

    @staticmethod
    def _library_result(library: dict, current: dict) -> dict:
        return {**library, 'revision': library_revision(library),
                'activeId': active_id(library, revision(current))}

    def layouts(self) -> dict:
        with self.layout_lock, layout_write_lock(self.paths):
            current = self._read_layout()
            library = self._read_library(current, initialize=True)
            return self._library_result(library, current)

    def save_layouts(self, raw: object, if_match: str | None) -> dict:
        if if_match is None:
            raise APIError(428, 'Updating saved layouts requires the library revision in If-Match')
        try:
            library = validate_library(raw)
        except LibraryTooLarge as error:
            raise APIError(413, str(error)) from error
        except (ValueError, RecursionError) as error:
            raise APIError(422, str(error)) from error
        with self.layout_lock, layout_write_lock(self.paths):
            current = self._read_layout()
            previous = self._read_library(current)
            current_revision = library_revision(previous)
            if if_match not in (current_revision, f'"{current_revision}"'):
                raise APIError(409, 'Saved layouts changed; reload the library before updating it', revision=current_revision)
            try:
                replacements = {entry['id']: entry for entry in library['entries']}
                for entry in previous['entries']:
                    replacement = replacements.get(entry['id'])
                    if replacement is None or revision(replacement['document']) != revision(entry['document']):
                        archive_layout(self.paths, serialize_layout(entry['document']).encode('utf-8'),
                                       reason='saved-layout-list-change')
                self.library.write(library)
            except OSError as error:
                raise APIError(500, f'Cannot preserve older saved layouts or save the dashboard library: {error}') from error
            return self._library_result(library, current)

    def switch_layout(self, raw: object, if_match: str | None) -> dict:
        if if_match is None:
            raise APIError(428, 'Switching requires the current panel layout revision in If-Match')
        with self.layout_lock, layout_write_lock(self.paths):
            current = self._read_layout()
            current_revision = revision(current)
            if if_match not in (current_revision, f'"{current_revision}"'):
                raise APIError(409, 'Saved layout changed; reload it before switching', revision=current_revision)
            library = self._read_library(current)
            try:
                entry = select_entry(library, current_revision, raw)
            except ValueError as error:
                raise APIError(422, str(error)) from error
            # Reuse every save check and reread the panel file under the same flock.
            result = self._save_locked(entry['document'], if_match)
            return {**result, 'activeId': active_id(library, result['revision'])}

    def status(self) -> dict:
        try:
            raw = strict_json(read_bounded(self.paths.status))
            if not isinstance(raw, dict):
                raise ValueError("runtime status must be an object")
            result = dict(raw)
        except FileNotFoundError:
            result = {}
        except (OSError, ValueError, APIError) as error:
            result = {"error": f"Cannot read runtime status: {error}"}
        result["runtimeRunning"] = runtime_is_running(result)
        result["usbPresent"] = usb_present()
        try:
            result["requestedRevision"] = self.layout()["revision"]
        except APIError as error:
            result["requestedRevision"] = None
            result["layoutError"] = str(error)
        return result

    def live(self) -> dict:
        try:
            snapshot = validate_snapshot(strict_json(read_bounded(self.paths.live)))
            runtime = strict_json(read_bounded(self.paths.status))
            if not isinstance(runtime, dict) or not runtime_is_running(runtime) or any(snapshot[key] != runtime.get(key) for key in ('pid', 'processStart')):
                raise ValueError('Live readings belong to a stopped runtime.')
            age = time.time() - snapshot['observedAt']
            stale = age < -1 or age > MAX_AGE
            result = {**snapshot, 'available': not stale, 'stale': stale,
                      'sources': source_diagnostics(snapshot, stale=stale)}
            if stale:
                result['error'] = 'Live readings are stale. Showing sample values until the runtime publishes fresh readings.'
            return result
        except (OSError, ValueError, APIError):
            return {'available': False, 'stale': True, 'sources': [],
                    'error': 'Live readings are unavailable. The runtime needs the current Studio adapter.'}

    def preview(self, raw: object, *, live: bool = False) -> bytes:
        try:
            document = validate_layout(raw, panel=False)
            if document["canvas"]["width"] * document["canvas"]["height"] > MAX_PREVIEW_PIXELS:
                raise ValueError("Preview is limited to 16 million pixels")
            with self.palette_lock:
                colors = self.palette.poll() if document.get("paletteMode") == "live" else None
            usage = self.usage.snapshot() if live and any(widget['settings'].get('source') in USAGE_SOURCES or widget['type'] == 'storage' for widget in document['widgets']) else None
            with self.render_lock:
                stats = None
                if live:
                    readings = self.live()
                    if not readings['available']:
                        raise APIError(503, readings['error'])
                    stats = snapshot_stats(readings)
                    if usage is not None:
                        stats = UsageStats(stats, usage)
                image = self.renderer.render(document, stats=stats, palette=colors)
                try:
                    output = BytesIO()
                    image.save(output, format="PNG")
                    if live:
                        current = self.live()
                        age = time.time() - readings['observedAt']
                        if not current['available'] or any(current.get(key) != readings[key] for key in ('pid', 'processStart')) or age < -1 or age > MAX_AGE:
                            raise APIError(503, 'Live readings expired during preview. Showing sample values until fresh readings are available.')
                    return output.getvalue()
                finally:
                    image.close()
        except (ValueError, RecursionError) as error:
            raise APIError(422, str(error)) from error


class StudioHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, app: StudioApplication, port: int = 5174) -> None:
        self.app = app
        super().__init__(("127.0.0.1", port), StudioHandler)


class StudioHandler(BaseHTTPRequestHandler):
    server: StudioHTTPServer

    def _reply(self, status: int, data: bytes, content_type: str = "application/json; charset=utf-8",
               *, etag: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if etag is not None:
            self.send_header("ETag", f'"{etag}"')
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, status: int, value: object, *, etag: str | None = None) -> None:
        data = json.dumps(value, ensure_ascii=True, allow_nan=False).encode("utf-8")
        self._reply(status, data, etag=etag)

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        self._json(code, {"error": message or self.responses.get(code, ("HTTP error",))[0]})

    def _check_request(self) -> str:
        hosts = self.headers.get_all("Host", [])
        port = self.server.server_port
        if len(hosts) != 1 or hosts[0] not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            raise APIError(403, "Host must be the Studio loopback address and port")
        origins = self.headers.get_all("Origin", [])
        if origins and (len(origins) != 1 or origins[0] != f"http://{hosts[0]}"):
            raise APIError(403, "Origin must match the Studio loopback address")
        return urlsplit(self.path).path

    def _body(self) -> object:
        types = self.headers.get_all("Content-Type", [])
        if len(types) != 1 or types[0].split(";", 1)[0].strip().lower() != "application/json":
            raise APIError(415, "POST requests require application/json")
        if self.headers.get_all("Transfer-Encoding"):
            raise APIError(400, "Transfer-Encoding is unsupported; send Content-Length")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
            raise APIError(400, "Send one valid Content-Length")
        try:
            length = int(lengths[0])
        except ValueError as error:
            raise APIError(400, "Invalid Content-Length") from error
        if length > MAX_BODY_BYTES:
            raise APIError(413, "JSON request exceeds the 1 MB limit")
        data = self.rfile.read(length)
        if len(data) != length:
            raise APIError(400, "Incomplete JSON request body")
        return strict_json(data)

    def _static(self, path: str) -> None:
        root = self.server.app.dist
        if not root.is_dir():
            raise APIError(503, "Studio build is missing. Run pnpm build, then restart the server.")
        decoded = unquote(path)
        if "\x00" in decoded or "\\" in decoded or ".." in decoded.split("/"):
            raise APIError(404, "Static file not found")
        target = (root / decoded.lstrip("/")).resolve()
        if not target.is_relative_to(root):
            raise APIError(404, "Static file not found")
        if decoded == "/":
            target = (root / "index.html").resolve()
        elif not target.is_file() and not Path(decoded).suffix and not decoded.startswith("/assets/"):
            if "text/html" in self.headers.get("Accept", ""):
                target = (root / "index.html").resolve()
        if not target.is_relative_to(root) or not target.is_file():
            if decoded == "/":
                raise APIError(503, "Studio index.html is missing. Run pnpm build.")
            raise APIError(404, "Static file not found")
        self._reply(200, target.read_bytes(), mimetypes.guess_type(target.name)[0] or "application/octet-stream")

    def _handle(self) -> None:
        try:
            self.connection.settimeout(15)
            path = self._check_request()
            app = self.server.app
            if self.command in ("GET", "HEAD"):
                if path == "/api/layout":
                    result = app.layout()
                    self._json(200, result, etag=result["revision"])
                elif path == "/api/layouts":
                    result = app.layouts()
                    self._json(200, result, etag=result['revision'])
                elif path == "/api/widgets":
                    result = app.widgets()
                    self._json(200, result, etag=result["revision"])
                elif path == "/api/status":
                    self._json(200, app.status())
                elif path == "/api/usage":
                    self._json(200, app.usage.snapshot())
                elif path == "/api/live":
                    self._json(200, app.live())
                elif path == "/api/history":
                    self._json(200, {"archives": list_archives(app.paths)})
                elif path.startswith('/api/history/'):
                    try:
                        result = read_archive(app.paths, path.removeprefix('/api/history/'))
                    except (OSError, ValueError) as error:
                        raise APIError(404, f'Archived layout unavailable: {error}') from error
                    self._json(200, result, etag=result['revision'])
                elif path == "/api/palette":
                    with app.palette_lock:
                        self._json(200, {"palette": app.palette.poll(), "error": app.palette.error})
                elif path == "/api/frame":
                    try:
                        frame = app.paths.frame.read_bytes()
                    except FileNotFoundError as error:
                        raise APIError(404, "Runtime has not saved a frame yet") from error
                    self._reply(200, frame, "image/png")
                elif path == "/api" or path.startswith("/api/"):
                    raise APIError(404, "API endpoint not found")
                else:
                    self._static(path)
            elif self.command == "POST":
                if path not in ("/api/layout", "/api/layouts", "/api/layouts/switch", "/api/widgets", "/api/preview"):
                    raise APIError(404, "API endpoint not found")
                raw = self._body()
                if path in ("/api/layout", "/api/layouts", "/api/layouts/switch", "/api/widgets"):
                    matches = self.headers.get_all("If-Match", [])
                    if len(matches) > 1:
                        raise APIError(400, "Send only one If-Match header")
                    action = {'/api/layout': app.save, '/api/layouts': app.save_layouts,
                              '/api/layouts/switch': app.switch_layout, '/api/widgets': app.save_widgets}[path]
                    result = action(raw, matches[0] if matches else None)
                    self._json(200, result, etag=result["revision"])
                else:
                    query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                    mode = query.get('mode', ['sample'])
                    if len(mode) != 1 or mode[0] not in ('sample', 'live') or set(query) - {'mode'}:
                        raise APIError(400, 'Preview mode must be sample or live.')
                    self._reply(200, app.preview(raw, live=mode[0] == 'live'), "image/png")
            else:
                raise APIError(405, "Method not supported")
        except APIError as error:
            self._json(error.status, {"error": str(error), **error.details})
        except (TimeoutError, OSError) as error:
            try:
                self._json(500, {"error": f"Studio file or connection error: {error}"})
            except OSError:
                pass
        except (ValueError, RecursionError) as error:
            self._json(400, {"error": str(error)})
        except Exception:
            self._json(500, {"error": "Studio could not complete the request"})

    do_GET = _handle
    do_HEAD = _handle
    do_POST = _handle
    do_PUT = _handle
    do_PATCH = _handle
    do_DELETE = _handle
    do_OPTIONS = _handle
    do_TRACE = _handle
    do_CONNECT = _handle


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve TURZX Studio on loopback without opening USB")
    parser.add_argument("--port", type=int, default=5174)
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--runtime-dir", type=Path)
    parser.add_argument("--dist", type=Path)
    parser.add_argument("--font-dir", type=Path)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    app = StudioApplication(Paths(args.state_dir, args.runtime_dir), dist=args.dist, font_dir=args.font_dir)
    server = StudioHTTPServer(app, args.port)
    print(f"TURZX Studio: http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
