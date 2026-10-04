"""Adapt the existing dashboard loop without changing its USB lifecycle."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import time

from .layout import effective_palette
from .renderer import LayoutRenderer
from .watch import LayoutWatcher
from .storage import Paths, PaletteWatcher, atomic_write

MAX_RESPONSE_BYTES = 64


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
    devices = set(usb_paths())
    for proc in Path('/proc').glob('[0-9]*'):
        if int(proc.name) == os.getpid():
            continue
        try:
            for fd in (proc / 'fd').iterdir():
                try:
                    if os.readlink(fd) in devices:
                        raise RuntimeError(f'TURZX USB is owned by process {proc.name}')
                except OSError:
                    continue
        except OSError:
            continue


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
        self.invalidate_frame(pid=os.getpid(), processStart=process_start(os.getpid()),
                              connected=False, view='stats', error=None,
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
        owner = self

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
                        frame = self.layout.render(owner.document, stats=stats, palette=owner.palette)
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
            owner.layouts.poll()
            owner.document = owner.layouts.document
            live = owner.scheme.poll()
            owner.palette = effective_palette(owner.document, live) if owner.document else None
            owner.frame_revision = owner.layouts.revision
            owner.publish(view=kwargs.get('view', 'stats'),
                          error=owner.render_error or owner.transport_error or owner.layouts.error or owner.scheme.error)
            palette_key = hashlib.sha256(json.dumps(owner.palette, sort_keys=True).encode()).hexdigest()
            return (legacy_dirty(*args, **kwargs), owner.frame_revision, palette_key)

        def open_lcd(*args, **kwargs):
            try:
                assert_usb_available()
                lcd = legacy_open(*args, **kwargs)
                owner.transport_error = None
                owner.publish(connected=True, error=None)
                return lcd
            except Exception as error:
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
        originals = []
        try:
            for module, name, replacement in bindings:
                originals.append((module, name, getattr(module, name)))
                setattr(module, name, replacement)
        except Exception:
            for module, name, original in reversed(originals):
                setattr(module, name, original)
            raise
