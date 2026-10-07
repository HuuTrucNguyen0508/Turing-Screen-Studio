"""Adapt the existing dashboard loop without changing its USB lifecycle."""
from __future__ import annotations

import hashlib
import errno
import fcntl
import json
import os
from pathlib import Path
import struct
import time

from .layout import GAUGE_STYLES, effective_palette
from .renderer import LayoutRenderer
from .watch import LayoutWatcher
from .storage import Paths, PaletteWatcher, atomic_write
from .usage import UsageCollector
from .usage_display import USAGE_SOURCES, UsageStats
from .activity import T3Activity
from .games import GameResources
from .dashboard_display import DASHBOARD_SOURCES, DashboardStats, dashboard_content
from .live import LiveHistory, HistoryStats
from .usb_ownership import open_claimed_device

MAX_RESPONSE_BYTES = 64


def dashboard_snapshot(collector):
    """A display-only source failure must not interrupt the panel loop."""
    try:
        return collector.snapshot()
    except Exception:
        return None


def process_start(pid: int) -> str:
    return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]


def usb_paths() -> list[str]:
    paths = []
    for device in Path('/sys/bus/usb/devices').glob('*'):
        try:
            if (device / 'idVendor').read_text().strip() == '1cbe' and (device / 'idProduct').read_text().strip() == '0080':
                bus = int((device / 'busnum').read_text())
                number = int((device / 'devnum').read_text())
                paths.append(f'/dev/bus/usb/{bus:03}/{number:03}')
        except (OSError, ValueError):
            continue
    return paths


def assert_usb_available() -> None:
    # Linux GETDRIVER reports claims, unlike a /proc descriptor scan.
    # usbfs requires O_RDWR even for this query; it sends no USB command.
    request = (1 << 30) | (struct.calcsize('I256s') << 16) | (ord('U') << 8) | 8
    for path in usb_paths():
        fd = os.open(path, os.O_RDWR | os.O_CLOEXEC)
        try:
            data = bytearray(struct.pack('I256s', 0, b''))
            try:
                fcntl.ioctl(fd, request, data, True)
            except OSError as error:
                if error.errno == errno.ENODATA:
                    continue
                raise
            driver = data[4:].split(b'\0', 1)[0].decode('ascii', 'replace')
            raise RuntimeError(f'TURZX USB interface 0 is claimed by {driver or "an unknown driver"}')
        finally:
            os.close(fd)


class RuntimeIntegration:
    def __init__(self, paths: Paths | None = None, scheme: Path | None = None):
        self.paths = paths or Paths()
        self.layouts = LayoutWatcher(self.paths.layout, panel=True)
        self.scheme = PaletteWatcher(scheme or Path.home() / '.local/state/caelestia/scheme.json')
        self.document = None
        self.palette = None
        self.frame_revision = None
        self.rendered_revision = None
        self.rendered_view = 'stats'
        self.rendered_layout = False
        self.render_error = None
        self.transport_ok = False
        self.frame_accepted = False
        self.transport_error = None
        self.response = None
        self.last_capture = 0.0
        self.status = {}
        self.usage = UsageCollector()
        self.usage_snapshot = None
        self.activity = T3Activity()
        self.games = GameResources(self.paths.state_dir / 'game-timers.json')
        self.activity_snapshot = None
        self.games_snapshot = None
        self.usb_device = None
        self.live = LiveHistory()
        self.last_live_publish = 0.0
        self.live_identity = process_start(os.getpid())
        self.invalidate_frame(pid=os.getpid(), processStart=process_start(os.getpid()),
                              connected=False, view='stats', error=None,
                              supportedWidgetTypes=['metric', 'weather', 'clock', 'text', 'gauge', 'storage'],
                              supportedGaugeStyles=list(GAUGE_STYLES),
                              supportedDesignTypes=['clock'],
                              supportedTrendWidgets=True,
                              supportedChrome=True,
                              supportedStorageViews=['drives', 'partitions'],
                              supportedUsageSources=list(USAGE_SOURCES),
                              supportedDashboardSources=list(DASHBOARD_SOURCES),
                              responseHex=None, responseBytes=None, responseTruncated=False)

    def invalidate_frame(self, **changes):
        self.last_capture = 0.0
        try:
            self.paths.frame.unlink(missing_ok=True)
        except OSError as error:
            print(f'Studio stale frame could not be removed: {error}', flush=True)
        self.publish(**{'appliedRevision': None, 'frameRevision': None, 'frameTime': None, **changes})

    def publish(self, **changes):
        next_status = {**self.status, **changes}
        if next_status != self.status or not self.paths.status.exists():
            self.status = next_status
            try:
                atomic_write(self.paths.status, (json.dumps(self.status) + '\n').encode())
            except OSError as error:
                print(f'Studio status unavailable: {error}', flush=True)

    def install(self, dashboard, transport):
        legacy_renderer = dashboard.DashboardRenderer
        legacy_dirty = dashboard.logical_dirty_key
        legacy_write = dashboard.try_lcd_write
        legacy_open = dashboard.open_lcd
        legacy_scheme = dashboard.SchemeWatcher
        legacy_close = getattr(dashboard, 'close_lcd', None)
        owns_usb = hasattr(transport, 'find_usb_device')
        owner = self

        def find_owned_device():
            device, product = open_claimed_device(transport.usb.core, transport.usb.util,
                                                  transport.VENDOR_ID, transport.PRODUCT_ID)
            owner.usb_device = device
            return device, product

        def dispose_device(device):
            if device is not None:
                try:
                    transport.usb.util.dispose_resources(device)
                finally:
                    if owner.usb_device is device:
                        owner.usb_device = None

        def close_lcd(lcd):
            try:
                return legacy_close(lcd)
            finally:
                dispose_device(getattr(lcd, 'dev', None))

        class SafeScheme(legacy_scheme):
            def __init__(self, *args, **kwargs):
                try:
                    super().__init__(*args, **kwargs)
                except (OSError, ValueError, KeyError, TypeError) as error:
                    import theme
                    self.path = kwargs.get('path', args[0] if args else theme.CAELESTIA_SCHEME)
                    self._mtime = None
                    self.palette = theme.fallback_palette()
                    owner.publish(error=f'Caelestia scheme: {error}')

            def poll(self):
                try:
                    return super().poll()
                except (OSError, ValueError, KeyError, TypeError) as error:
                    owner.publish(error=f'Caelestia scheme: {error}')
                    return self.palette

        class Adapter:
            def __init__(self, font_dir, palette):
                self.legacy = legacy_renderer(font_dir, palette=palette)
                self.layout = LayoutRenderer(font_dir=font_dir)

            @property
            def palette(self):
                return self.legacy.palette

            @palette.setter
            def palette(self, value):
                self.legacy.palette = value

            def render(self, stats):
                owner.rendered_layout = False
                owner.rendered_revision = None
                owner.rendered_view = 'stats'
                if owner.document is not None:
                    try:
                        rendered_revision = owner.frame_revision
                        display_stats = HistoryStats(stats, owner.live.histories) if stats is not None else None
                        if owner.usage_snapshot is not None:
                            display_stats = UsageStats(display_stats, owner.usage_snapshot)
                        if owner.activity_snapshot is not None or owner.games_snapshot is not None:
                            display_stats = DashboardStats(display_stats, owner.activity_snapshot, owner.games_snapshot)
                        frame = self.layout.render(owner.document, stats=display_stats, palette=owner.palette)
                        owner.rendered_layout = True
                        owner.rendered_revision = rendered_revision
                        owner.render_error = None
                        return frame
                    except Exception as error:
                        owner.render_error = f'Layout render failed; using original dashboard: {error}'
                        owner.publish(error=owner.render_error)
                return self.legacy.render(stats)

            def render_speedtest(self, state):
                owner.rendered_layout = False
                owner.rendered_revision = None
                owner.rendered_view = 'speedtest'
                return self.legacy.render_speedtest(state)

        def dirty(*args, **kwargs):
            # Reuse existing readings even when USB dirty-skip avoids rendering.
            stats = kwargs.get('stats', args[2] if len(args) > 2 else None)
            if owner.live.observe(stats):
                now = time.monotonic()
                if now - owner.last_live_publish >= 2:
                    try:
                        snapshot = owner.live.snapshot(os.getpid(), owner.live_identity)
                        atomic_write(owner.paths.live, (json.dumps(snapshot, allow_nan=False) + '\n').encode())
                        owner.last_live_publish = now
                    except (OSError, ValueError):
                        # Preview telemetry must not interrupt the dashboard.
                        pass
            owner.layouts.poll()
            owner.document = owner.layouts.document
            live = owner.scheme.poll()
            owner.palette = effective_palette(owner.document, live) if owner.document else None
            owner.frame_revision = owner.layouts.revision
            owner.publish(view=kwargs.get('view', 'stats'),
                          error=owner.render_error or owner.transport_error or owner.layouts.error or owner.scheme.error)
            palette_key = hashlib.sha256(json.dumps(owner.palette, sort_keys=True).encode()).hexdigest()
            key = (legacy_dirty(*args, **kwargs), owner.frame_revision, palette_key)
            sources = {widget['settings'].get('source') for widget in owner.document['widgets']} if owner.document else set()
            owner.activity_snapshot = dashboard_snapshot(owner.activity) if 't3-threads' in sources else None
            owner.games_snapshot = dashboard_snapshot(owner.games) if 'game-resources' in sources else None
            if sources.intersection(DASHBOARD_SOURCES):
                transient = DashboardStats(None, owner.activity_snapshot, owner.games_snapshot)
                displayed = [dashboard_content(widget, transient) for widget in owner.document['widgets']
                             if widget['settings'].get('source') in DASHBOARD_SOURCES]
                key = (*key, hashlib.sha256(json.dumps(displayed, sort_keys=True).encode()).hexdigest())
            if owner.document and any(widget['settings'].get('trend') for widget in owner.document['widgets']):
                key = (*key, owner.live.observed_at)
            if owner.document and any(widget['settings'].get('source') in USAGE_SOURCES or (widget['type'] == 'storage' and widget['settings'].get('source') == 'mounted-storage') for widget in owner.document['widgets']):
                owner.usage_snapshot = owner.usage.snapshot()
                return (*key, owner.usage_snapshot.get('readAt'))
            owner.usage_snapshot = None
            return key

        def open_lcd(*args, **kwargs):
            try:
                assert_usb_available()
                lcd = legacy_open(*args, **kwargs)
                owner.transport_error = None
                owner.publish(connected=True, error=None)
                return lcd
            except Exception as error:
                if owns_usb:
                    try:
                        dispose_device(owner.usb_device)
                    except Exception as cleanup_error:
                        error = RuntimeError(f'{error}; USB cleanup failed: {cleanup_error}')
                owner.transport_error = str(error)
                owner.invalidate_frame(connected=False, error=owner.transport_error)
                raise

        # None is a swallowed USB error. Unknown nonempty replies keep the
        # legacy handle alive, but cannot acknowledge a revision or capture.
        def checked_send(send):
            def checked(*args, **kwargs):
                try:
                    reply = send(*args, **kwargs)
                except Exception as error:
                    owner.transport_error = f'Panel upload failed; reconnecting: {error}'
                    raise
                owner.response = reply
                if not reply:
                    owner.transport_error = 'Panel upload failed; reconnecting: no transport response'
                    raise RuntimeError(owner.transport_error)
                owner.transport_ok = True
                owner.frame_accepted = transport._resp_ok(reply)
                if not owner.frame_accepted:
                    owner.transport_error = (
                        f'Panel returned an unrecognized response ({len(reply)} bytes, '
                        f'hex {reply[:MAX_RESPONSE_BYTES].hex()}); connection kept open; '
                        'frame acceptance unconfirmed'
                    )
                return reply
            return checked

        def write(lcd, frame, brightness, applied_brightness):
            # Pin metadata before the upload, even if another poll runs later.
            rendered_revision = owner.rendered_revision
            rendered_layout = owner.rendered_layout
            view = owner.rendered_view
            owner.transport_ok = False
            owner.frame_accepted = False
            owner.transport_error = None
            owner.response = None
            ok, applied = legacy_write(lcd, frame, brightness, applied_brightness)
            response = owner.response
            changes = {'responseHex': response[:MAX_RESPONSE_BYTES].hex() if response is not None else None,
                       'responseBytes': len(response) if response is not None else None,
                       'responseTruncated': response is not None and len(response) > MAX_RESPONSE_BYTES,
                       'view': view}
            if not ok:
                owner.transport_error = owner.transport_error or 'Panel upload failed; reconnecting'
                owner.invalidate_frame(connected=False, error=owner.transport_error, **changes)
                return False, applied
            changes['connected'] = True
            if not owner.transport_ok or not owner.frame_accepted:
                owner.transport_error = owner.transport_error or 'Panel upload acceptance unconfirmed: no frame reply observed'
                owner.invalidate_frame(error=owner.transport_error, **changes)
                return True, applied
            if rendered_layout and view == 'stats':
                changes.update(appliedRevision=rendered_revision, error=owner.layouts.error or owner.scheme.error)
                now = time.monotonic()
                if rendered_revision != owner.status.get('frameRevision') or now - owner.last_capture >= 10:
                    try:
                        from io import BytesIO
                        buffer = BytesIO()
                        frame.save(buffer, format='PNG')
                        atomic_write(owner.paths.frame, buffer.getvalue())
                        changes.update(frameRevision=rendered_revision, frameTime=time.time())
                        owner.last_capture = now
                    except OSError as error:
                        changes['error'] = f'Panel frame capture unavailable: {error}'
                        owner.invalidate_frame(**changes)
                        return True, applied
            else:
                owner.invalidate_frame(error=owner.render_error or owner.layouts.error or owner.scheme.error, **changes)
                return True, applied
            owner.publish(**changes)
            return True, applied

        bindings = [(transport, 'send_image', checked_send(transport.send_image)),
                    (transport, 'send_jpeg', checked_send(transport.send_jpeg)),
                    (dashboard, 'DashboardRenderer', Adapter),
                    (dashboard, 'logical_dirty_key', dirty),
                    (dashboard, 'try_lcd_write', write),
                    (dashboard, 'open_lcd', open_lcd),
                    (dashboard, 'SchemeWatcher', SafeScheme)]
        if owns_usb:
            if not callable(legacy_close):
                raise RuntimeError('Dashboard USB cleanup function is unavailable')
            bindings[:0] = [(transport, 'find_usb_device', find_owned_device),
                            (dashboard, 'close_lcd', close_lcd)]
        originals = []
        try:
            for module, name, replacement in bindings:
                originals.append((module, name, getattr(module, name)))
                setattr(module, name, replacement)
        except Exception:
            for module, name, original in reversed(originals):
                setattr(module, name, original)
            raise
