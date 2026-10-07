import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PIL import Image
from launch_dashboard import install_adapter, publish_adapter_failure
from turzx_studio.integration import MAX_RESPONSE_BYTES, RuntimeIntegration
from turzx_studio.layout import parse_layout, revision, serialize_layout
from turzx_studio.storage import Paths, atomic_write


class LegacyRenderer:
    def __init__(self, font_dir, palette):
        self.palette = palette
    def render(self, stats):
        return Image.new('RGB', (1280, 800), 'red')
    def render_speedtest(self, state):
        return self.render(state)


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        root = Path(self.temp.name)
        self.paths = Paths(state_dir=root / 'state', runtime_dir=root / 'run')
        self.doc = parse_layout((Path(__file__).parents[2] / 'public/sample-layout.json').read_text())
        atomic_write(self.paths.layout, serialize_layout(self.doc).encode())
        self.reply = b'\x00\xc8'
        self.upload_error = None
        self.send_method = 'send_image'
        def send_reply(*args):
            if self.upload_error is not None:
                raise self.upload_error
            return self.reply
        self.transport = SimpleNamespace(send_image=send_reply, send_jpeg=send_reply,
            _resp_ok=lambda r: bool(r and ((len(r) > 1 and r[1] == 200) or (len(r) > 8 and r[8] == 200))))
        def legacy_write(lcd, frame, brightness, applied):
            try:
                getattr(self.transport, self.send_method)(None, b'frame')
                return True, brightness
            except Exception:
                return False, applied
        self.dashboard = SimpleNamespace(DashboardRenderer=LegacyRenderer, logical_dirty_key=lambda *a, **kw: 'same',
            try_lcd_write=legacy_write, open_lcd=lambda: object(), SchemeWatcher=type('Scheme', (), {'poll': lambda s: s.palette}))
        self.dashboard_originals = dict(vars(self.dashboard))
        self.owner = RuntimeIntegration(self.paths, root / 'missing-scheme')
        self.owner.install(self.dashboard, self.transport)
        self.renderer = self.dashboard.DashboardRenderer(None, palette=object())

    def tearDown(self):
        self.temp.cleanup()

    def test_thread_and_timer_source_failures_do_not_interrupt_dirty_or_render(self):
        root = Path(__file__).parents[2]
        thread = next(card for card in json.loads((root / 'layouts/ai-usage-30d.json').read_text())['widgets'] if card['id'] == 't3-threads')
        game = next(card for card in json.loads((root / 'layouts/system-overview-clean.json').read_text())['widgets'] if card['id'] == 'game-resources')
        atomic_write(self.paths.layout, serialize_layout({**self.doc, 'widgets': [thread, game]}).encode())
        self.owner.activity.snapshot = Mock(side_effect=RuntimeError('unexpected source failure'))
        self.owner.games.snapshot = Mock(side_effect=RuntimeError('unexpected source failure'))
        self.dashboard.logical_dirty_key(view='stats')
        self.assertIsNone(self.owner.activity_snapshot)
        self.assertIsNone(self.owner.games_snapshot)
        self.owner.activity.snapshot.assert_called_once()
        self.owner.games.snapshot.assert_called_once()
        frame = self.renderer.render(SimpleNamespace())
        self.assertTrue(self.owner.rendered_layout)
        self.assertEqual(frame.size, (1280, 800))
        frame.close()

    def send(self):
        self.dashboard.logical_dirty_key(view='stats')
        frame = self.renderer.render(None)
        return self.dashboard.try_lcd_write(None, frame, 50, 50)

    def test_dirty_skip_publishes_existing_stats_without_render_or_transport(self):
        self.owner.live.clock = lambda: 1000
        render = Mock()
        self.renderer.layout.render = render
        stats = SimpleNamespace(cpu_percent=31, gpu_percent=None)
        self.dashboard.logical_dirty_key(None, None, stats, view='stats')
        snapshot = json.loads(self.paths.live.read_text())
        self.assertEqual(snapshot['stats']['cpu_percent'], 31)
        self.assertEqual(snapshot['history']['cpu'], [31])
        self.assertEqual(snapshot['processStart'], self.owner.live_identity)
        render.assert_not_called()
        self.assertIsNone(self.owner.status['appliedRevision'])

    def test_live_publish_failure_does_not_break_original_dirty_key(self):
        original = atomic_write
        def write(path, data):
            if path == self.paths.live:
                raise OSError('No space')
            original(path, data)
        with patch('turzx_studio.integration.atomic_write', side_effect=write):
            result = self.dashboard.logical_dirty_key(None, None, SimpleNamespace(cpu_percent=31), view='stats')
        self.assertEqual(result[0], 'same')
        self.assertFalse(self.paths.live.exists())

    def test_only_positive_transport_reply_acknowledges_layout(self):
        for method in ('send_image', 'send_jpeg'):
            for reply in (b'\x00\xc8', b'\x00' * 8 + b'\xc8'):
                with self.subTest(method=method, reply=reply):
                    self.send_method = method
                    self.reply = reply
                    self.assertTrue(self.send()[0])
                    self.assertTrue(self.owner.status['connected'])
                    self.assertEqual(self.owner.status['appliedRevision'], revision(self.doc))
                    self.assertEqual(self.owner.status['frameRevision'], revision(self.doc))
                    self.assertTrue(self.paths.frame.exists())

    def test_unknown_nonempty_response_keeps_connection_without_ack_or_capture(self):
        for method in ('send_image', 'send_jpeg'):
            for reply in (b'\x00', b'\x00\x00', b'\xab' * 512):
                with self.subTest(method=method, reply_length=len(reply)):
                    self.send_method = method
                    self.reply = b'\x00\xc8'
                    self.assertTrue(self.send()[0])
                    self.assertTrue(self.paths.frame.exists())
                    self.reply = reply
                    self.assertTrue(self.send()[0])
                    status = json.loads(self.paths.status.read_text())
                    self.assertTrue(status['connected'])
                    self.assertIsNone(status['appliedRevision'])
                    self.assertIsNone(status['frameRevision'])
                    self.assertIsNone(status['frameTime'])
                    self.assertFalse(self.paths.frame.exists())
                    self.assertEqual(status['responseHex'], reply[:MAX_RESPONSE_BYTES].hex())
                    self.assertEqual(status['responseBytes'], len(reply))
                    self.assertEqual(status['responseTruncated'], len(reply) > MAX_RESPONSE_BYTES)
                    self.assertIn('unrecognized response', status['error'])
                    self.assertIn('connection kept open', status['error'])
                    self.dashboard.logical_dirty_key(view='stats')
                    self.assertEqual(self.owner.status['error'], status['error'])

    def test_missing_transport_response_reconnects_and_clears_previous_ack(self):
        for method in ('send_image', 'send_jpeg'):
            for reply in (None, b''):
                with self.subTest(method=method, reply=reply):
                    self.send_method = method
                    self.reply = b'\x00\xc8'
                    self.assertTrue(self.send()[0])
                    self.reply = reply
                    self.assertFalse(self.send()[0])
                    self.assertFalse(self.owner.status['connected'])
                    self.assertIsNone(self.owner.status['appliedRevision'])
                    self.assertIsNone(self.owner.status['frameRevision'])
                    self.assertFalse(self.paths.frame.exists())
                    self.assertIn('no transport response', self.owner.status['error'])

    def test_transport_exception_reconnects_with_original_error(self):
        for method in ('send_image', 'send_jpeg'):
            with self.subTest(method=method):
                self.send_method = method
                self.upload_error = None
                self.assertTrue(self.send()[0])
                self.upload_error = OSError('device gone')
                self.assertFalse(self.send()[0])
                self.assertFalse(self.owner.status['connected'])
                self.assertIsNone(self.owner.status['appliedRevision'])
                self.assertFalse(self.paths.frame.exists())
                self.assertIsNone(self.owner.status['responseHex'])
                self.assertIn('device gone', self.owner.status['error'])

    def test_dirty_key_changes_for_geometry_and_ack_pins_rendered_revision(self):
        first = self.dashboard.logical_dirty_key(view='stats')
        old_revision = revision(self.doc)
        frame = self.renderer.render(None)
        self.doc['widgets'][0]['x'] += 1
        atomic_write(self.paths.layout, serialize_layout(self.doc).encode())
        second = self.dashboard.logical_dirty_key(view='stats')
        self.assertNotEqual(first, second)
        self.assertEqual(self.owner.frame_revision, revision(self.doc))
        self.dashboard.try_lcd_write(None, frame, 50, 50)
        self.assertEqual(self.owner.status['appliedRevision'], old_revision)
        self.assertEqual(self.owner.status['frameRevision'], old_revision)
        with Image.open(self.paths.frame) as capture:
            self.assertEqual(capture.tobytes(), frame.tobytes())

    def test_mounted_storage_alone_collects_live_rows_and_invalidates_on_refresh(self):
        self.doc['widgets'] = [dict(id='disks', type='storage', x=64, y=160, width=564, height=480,
                                    settings=dict(label='Disks', style='bars', source='mounted-storage'))]
        atomic_write(self.paths.layout, serialize_layout(self.doc).encode())
        first_snapshot = dict(readAt='first', mountedStorage=dict(mounts=[], stale=False, errors=[]))
        second_snapshot = dict(readAt='second', mountedStorage=dict(mounts=[], stale=False, errors=[]))
        self.owner.usage.snapshot = Mock(side_effect=[first_snapshot, second_snapshot])
        first = self.dashboard.logical_dirty_key(view='stats')
        self.assertEqual(self.owner.usage_snapshot, first_snapshot)
        self.renderer.render(SimpleNamespace())
        self.assertTrue(self.owner.rendered_layout)
        second = self.dashboard.logical_dirty_key(view='stats')
        self.assertNotEqual(first, second)
        self.assertIn('storage', self.owner.status['supportedWidgetTypes'])
        self.doc['widgets'][0]['settings']['source'] = 'sample'
        atomic_write(self.paths.layout, serialize_layout(self.doc).encode())
        self.dashboard.logical_dirty_key(view='stats')
        self.assertIsNone(self.owner.usage_snapshot)
        self.assertEqual(self.owner.usage.snapshot.call_count, 2)

    def test_speedtest_never_acknowledges_new_layout(self):
        self.assertTrue(self.send()[0])
        self.dashboard.logical_dirty_key(view='speedtest')
        frame = self.renderer.render_speedtest(None)
        self.assertTrue(self.dashboard.try_lcd_write(None, frame, 50, 50)[0])
        self.assertIsNone(self.owner.status['appliedRevision'])
        self.assertIsNone(self.owner.status['frameRevision'])
        self.assertFalse(self.paths.frame.exists())

    def test_renderer_failure_keeps_original_dashboard(self):
        self.assertTrue(self.send()[0])
        self.dashboard.logical_dirty_key(view='stats')
        with patch.object(self.renderer.layout, 'render', side_effect=ValueError('bad render')):
            frame = self.renderer.render(None)
        self.assertEqual(frame.getpixel((0, 0)), (255, 0, 0))
        self.assertFalse(self.owner.rendered_layout)
        self.assertIn('original dashboard', self.owner.status['error'])
        self.assertTrue(self.dashboard.try_lcd_write(None, frame, 50, 50)[0])
        self.assertIsNone(self.owner.status['appliedRevision'])
        self.assertIsNone(self.owner.status['frameRevision'])
        self.assertFalse(self.paths.frame.exists())
        self.assertIn('original dashboard', self.owner.status['error'])

    def test_capture_failure_keeps_ack_but_clears_old_capture(self):
        self.assertTrue(self.send()[0])
        self.doc['widgets'][0]['x'] += 1
        atomic_write(self.paths.layout, serialize_layout(self.doc).encode())
        def fail_capture(path, data):
            if path == self.paths.frame:
                raise OSError('capture full')
            atomic_write(path, data)
        with patch('turzx_studio.integration.atomic_write', side_effect=fail_capture):
            self.assertTrue(self.send()[0])
        self.assertEqual(self.owner.status['appliedRevision'], revision(self.doc))
        self.assertIsNone(self.owner.status['frameRevision'])
        self.assertFalse(self.paths.frame.exists())
        self.assertIn('capture full', self.owner.status['error'])

    def test_partial_install_failure_restores_original_dashboard_and_transport(self):
        class FailOnce(SimpleNamespace):
            def __setattr__(self, name, value):
                if name == 'logical_dirty_key' and self.fail_install:
                    self.fail_install = False
                    raise RuntimeError('cannot install dirty adapter')
                super().__setattr__(name, value)
        dashboard = FailOnce(**self.dashboard_originals, fail_install=True)
        original_transport = dict(vars(self.transport))
        with self.assertRaisesRegex(RuntimeError, 'cannot install dirty adapter'):
            self.owner.install(dashboard, self.transport)
        for name, original in self.dashboard_originals.items():
            self.assertIs(getattr(dashboard, name), original)
        for name, original in original_transport.items():
            self.assertIs(getattr(self.transport, name), original)

    def test_install_failure_publishes_disconnected_status_and_preserves_fallback(self):
        self.assertTrue(self.send()[0])
        dashboard = SimpleNamespace(**self.dashboard_originals)
        modules = {'library': SimpleNamespace(), 'library.lcd': SimpleNamespace(lcd_comm_turing_usb=self.transport)}
        def publish_failure(error):
            publish_adapter_failure(error, self.paths)
        with patch.dict('sys.modules', modules), \
                patch('turzx_studio.integration.RuntimeIntegration', return_value=self.owner), \
                patch.object(self.owner, 'install', side_effect=RuntimeError('bad adapter')), \
                patch('launch_dashboard.publish_adapter_failure', side_effect=publish_failure):
            self.assertFalse(install_adapter(dashboard))
        status = json.loads(self.paths.status.read_text())
        self.assertFalse(status['connected'])
        self.assertIsNone(status['appliedRevision'])
        self.assertIsNone(status['frameRevision'])
        self.assertIn('bad adapter', status['error'])
        self.assertFalse(self.paths.frame.exists())
        self.assertIs(dashboard.DashboardRenderer, LegacyRenderer)
        self.assertIs(dashboard.try_lcd_write, self.dashboard_originals['try_lcd_write'])

    def test_failure_status_write_error_still_preserves_fallback(self):
        dashboard = SimpleNamespace(**self.dashboard_originals)
        modules = {'library': SimpleNamespace(), 'library.lcd': SimpleNamespace(lcd_comm_turing_usb=self.transport)}
        with patch.dict('sys.modules', modules), \
                patch('turzx_studio.integration.RuntimeIntegration', return_value=self.owner), \
                patch.object(self.owner, 'install', side_effect=RuntimeError('bad adapter')), \
                patch('launch_dashboard.publish_adapter_failure', side_effect=OSError('status full')):
            self.assertFalse(install_adapter(dashboard))
        self.assertIs(dashboard.DashboardRenderer, LegacyRenderer)

    def test_constructor_failure_publishes_status_without_constructing_another_adapter(self):
        dashboard = SimpleNamespace(**self.dashboard_originals)
        modules = {'library': SimpleNamespace(), 'library.lcd': SimpleNamespace(lcd_comm_turing_usb=self.transport)}
        def publish_failure(error):
            publish_adapter_failure(error, self.paths)
        with patch.dict('sys.modules', modules), \
                patch('turzx_studio.integration.RuntimeIntegration', side_effect=RuntimeError('bad constructor')) as constructor, \
                patch('launch_dashboard.publish_adapter_failure', side_effect=publish_failure):
            self.assertFalse(install_adapter(dashboard))
        constructor.assert_called_once_with()
        status = json.loads(self.paths.status.read_text())
        self.assertFalse(status['connected'])
        self.assertEqual(status['processStart'], self.owner.status['processStart'])
        self.assertIn('bad constructor', status['error'])
        self.assertIs(dashboard.DashboardRenderer, LegacyRenderer)

    def test_usb_owner_failure_is_caught_at_open_boundary(self):
        with patch('turzx_studio.integration.assert_usb_available', side_effect=RuntimeError('owned')):
            with self.assertRaisesRegex(RuntimeError, 'owned'):
                self.dashboard.open_lcd()
        self.assertFalse(self.owner.status['connected'])

    def owned_adapter(self, fail_open=False, fail_close=False):
        device = object()
        transport = SimpleNamespace(send_image=lambda *a: self.reply, send_jpeg=lambda *a: self.reply,
            _resp_ok=self.transport._resp_ok, find_usb_device=Mock(), VENDOR_ID=0x1cbe, PRODUCT_ID={0x80: None},
            usb=SimpleNamespace(core=object(), util=SimpleNamespace(dispose_resources=Mock())))
        def open_device():
            acquired, _ = transport.find_usb_device()
            if fail_open:
                raise RuntimeError('initialization failed')
            return SimpleNamespace(dev=acquired)
        close = Mock(side_effect=RuntimeError('close failed') if fail_close else None)
        dashboard = SimpleNamespace(**{**self.dashboard_originals, 'open_lcd': open_device, 'close_lcd': close})
        owner = RuntimeIntegration(self.paths, Path(self.temp.name) / 'missing-scheme')
        owner.install(dashboard, transport)
        return owner, dashboard, transport, device

    def test_same_claimed_device_reaches_transport_and_is_disposed_on_close(self):
        owner, dashboard, transport, device = self.owned_adapter()
        with patch('turzx_studio.integration.assert_usb_available'), \
                patch('turzx_studio.integration.open_claimed_device', return_value=(device, 0x80)):
            lcd = dashboard.open_lcd()
            self.assertIs(lcd.dev, device)
            self.assertIs(owner.usb_device, device)
            transport.usb.util.dispose_resources.assert_not_called()
            dashboard.close_lcd(lcd)
        transport.usb.util.dispose_resources.assert_called_once_with(device)
        self.assertIsNone(owner.usb_device)

    def test_partial_initialization_failure_disposes_the_claim_and_reports_disconnected(self):
        owner, dashboard, transport, device = self.owned_adapter(fail_open=True)
        with patch('turzx_studio.integration.assert_usb_available'), \
                patch('turzx_studio.integration.open_claimed_device', return_value=(device, 0x80)):
            with self.assertRaisesRegex(RuntimeError, 'initialization failed'):
                dashboard.open_lcd()
        transport.usb.util.dispose_resources.assert_called_once_with(device)
        self.assertIsNone(owner.usb_device)
        self.assertFalse(owner.status['connected'])

    def test_close_error_still_disposes_the_claim(self):
        owner, dashboard, transport, device = self.owned_adapter(fail_close=True)
        with patch('turzx_studio.integration.assert_usb_available'), \
                patch('turzx_studio.integration.open_claimed_device', return_value=(device, 0x80)):
            lcd = dashboard.open_lcd()
            with self.assertRaisesRegex(RuntimeError, 'close failed'):
                dashboard.close_lcd(lcd)
        transport.usb.util.dispose_resources.assert_called_once_with(device)
        self.assertIsNone(owner.usb_device)

    def test_hardware_entrypoint_does_not_bypass_ownership_when_adapter_installation_fails(self):
        import os
        import sys
        from launch_dashboard import main
        live = Path.home() / 'Documents/dashboard'
        dashboard = SimpleNamespace(__file__=str(live / 'dashboard.py'), main=Mock())
        renderer = SimpleNamespace(__file__=str(live / 'renderer.py'))
        with patch.dict(sys.modules, {'dashboard': dashboard, 'renderer': renderer}), \
                patch.dict(os.environ, {'XDG_RUNTIME_DIR': self.temp.name}), \
                patch.object(sys, 'argv', ['launch_dashboard.py']), patch.object(sys, 'path', list(sys.path)), \
                patch('launch_dashboard.install_adapter', return_value=False), patch('launch_dashboard.fcntl.flock'):
            self.assertEqual(main(), 1)
        dashboard.main.assert_not_called()

    def test_new_adapter_clears_status_and_capture_from_previous_process(self):
        self.assertTrue(self.send()[0])
        RuntimeIntegration(self.paths, Path(self.temp.name) / 'missing-scheme')
        status = json.loads(self.paths.status.read_text())
        self.assertFalse(status['connected'])
        self.assertIsNone(status['appliedRevision'])
        self.assertIsNone(status['frameRevision'])
        self.assertIsNone(status['frameTime'])
        self.assertIsNone(status['responseHex'])
        self.assertFalse(self.paths.frame.exists())


if __name__ == '__main__':
    unittest.main()
