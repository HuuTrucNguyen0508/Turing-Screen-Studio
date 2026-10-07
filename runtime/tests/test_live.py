from copy import deepcopy
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PIL import Image
from server import APIError, StudioApplication, process_start
from turzx_studio.live import LiveHistory, MAX_HISTORY, source_diagnostics, snapshot_stats, validate_snapshot
from turzx_studio.storage import Paths, atomic_write


class LiveHistoryTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000.0
        self.history = LiveHistory(lambda: self.now)

    def test_history_is_bounded_detached_and_preserves_unavailable_gaps(self):
        for index in range(140):
            self.now += 1
            self.history.observe(SimpleNamespace(cpu_percent=index, gpu_percent=None))
        snapshot = self.history.snapshot(1, '123')
        self.assertEqual(len(snapshot['history']['cpu']), MAX_HISTORY)
        self.assertEqual(snapshot['history']['gpu'], [None] * MAX_HISTORY)
        snapshot['history']['cpu'].clear()
        self.assertEqual(len(self.history.histories['cpu']), MAX_HISTORY)

    def test_readings_throttle_and_clock_or_large_gap_do_not_connect_old_history(self):
        self.assertTrue(self.history.observe(SimpleNamespace(cpu_percent=10)))
        self.now += .5
        self.assertFalse(self.history.observe(SimpleNamespace(cpu_percent=20)))
        self.now += 20
        self.history.observe(SimpleNamespace(cpu_percent=30))
        self.assertEqual(list(self.history.histories['cpu']), [10, None, 30])
        self.now = 10
        self.history.observe(SimpleNamespace(cpu_percent=40))
        self.assertEqual(list(self.history.histories['cpu']), [40])

    def test_invalid_sensor_numbers_are_unknown_not_sample_or_zero(self):
        self.history.observe(SimpleNamespace(cpu_percent=float('nan'), gpu_percent=True, cpu_temp=10**1000))
        snapshot = self.history.snapshot(1, '123')
        json.dumps(snapshot, allow_nan=False)
        rows = source_diagnostics(snapshot)
        self.assertEqual(rows[0]['status'], 'unavailable')
        self.assertIsNone(rows[0]['value'])
        self.assertEqual(source_diagnostics(snapshot, stale=True)[0]['status'], 'stale')

    def test_strict_bounded_snapshot_rejects_invalid_numbers_text_history_and_identity(self):
        self.history.observe(SimpleNamespace(cpu_percent=10))
        original = self.history.snapshot(1, '123')
        for change in [lambda raw: raw.update(pid=True), lambda raw: raw.update(processStart='other'),
                       lambda raw: raw['stats'].update(cpu_percent=True),
                       lambda raw: raw['stats'].update(clock='a' * 257),
                       lambda raw: raw['history'].update(cpu=[1] * 121),
                       lambda raw: raw['history'].update(cpu=[float('inf')])]:
            with self.subTest(change=change):
                raw = deepcopy(original)
                change(raw)
                with self.assertRaises(ValueError):
                    validate_snapshot(raw)
        stats = snapshot_stats(original)
        stats.studio_history['cpu'].clear()
        self.assertEqual(original['history']['cpu'], [10])


class LivePreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        root = Path(self.temp.name)
        self.paths = Paths(root / 'state', root / 'run')
        self.app = StudioApplication(self.paths, scheme=root / 'no-scheme')
        self.doc = self.app.layout()['document']
        self.pid, self.start = os.getpid(), process_start(os.getpid())
        self.now = 1000.0
        history = LiveHistory(lambda: self.now)
        history.observe(SimpleNamespace(cpu_percent=73, clock='Wed, 7 October 12:34'))
        self.snapshot = history.snapshot(self.pid, self.start)
        atomic_write(self.paths.live, json.dumps(self.snapshot).encode())
        atomic_write(self.paths.status, json.dumps({'pid': self.pid, 'processStart': self.start}).encode())
        self.app.usage = Mock(snapshot=Mock(return_value={}))

    def tearDown(self):
        self.temp.cleanup()

    def test_live_preview_uses_existing_readings_and_never_changes_layout_or_archives(self):
        previous = self.paths.layout.read_bytes()
        rendered = []
        def render(document, stats, palette):
            rendered.append(stats)
            return Image.new('RGB', (10, 10))
        self.app.renderer.render = render
        with patch('server.time.time', return_value=self.now + 2):
            output = self.app.preview(self.doc, live=True)
            self.assertTrue(output.startswith(b'\x89PNG'))
            self.assertEqual(rendered[0].cpu_percent, 73)
            self.assertEqual(rendered[0].studio_history['cpu'], [73])
            self.app.preview(self.doc)
            self.assertIsNone(rendered[1])
            self.app.usage.snapshot.assert_not_called()
        self.assertEqual(self.paths.layout.read_bytes(), previous)
        self.assertFalse(self.paths.older_configs.exists())

    def test_stale_future_or_other_runtime_readings_cannot_render_as_live(self):
        for now in (self.now + 16, self.now - 2):
            with patch('server.time.time', return_value=now):
                self.assertFalse(self.app.live()['available'])
                self.assertEqual(self.app.live()['sources'][0]['status'], 'stale')
                with self.assertRaises(APIError) as caught:
                    self.app.preview(self.doc, live=True)
                self.assertEqual(caught.exception.status, 503)
        self.snapshot['processStart'] = '0'
        atomic_write(self.paths.live, json.dumps(self.snapshot).encode())
        self.assertFalse(self.app.live()['available'])

    def test_missing_corrupt_or_oversized_readings_are_reported_without_samples(self):
        for raw in (b'{', b'x' * (1024 * 1024 + 1)):
            atomic_write(self.paths.live, raw)
            result = self.app.live()
            self.assertFalse(result['available'])
            self.assertEqual(result['sources'], [])
        self.paths.live.unlink()
        self.assertFalse(self.app.live()['available'])

    def test_fresh_readings_report_known_and_unknown_sources(self):
        with patch('server.time.time', return_value=self.now):
            result = self.app.live()
        rows = {item['id']: item for item in result['sources']}
        self.assertTrue(result['available'])
        self.assertEqual(rows['cpu']['value'], 73)
        self.assertEqual(rows['gpu']['status'], 'unavailable')
        self.assertEqual(rows['weather']['status'], 'unavailable')
        self.assertEqual(rows['clock']['status'], 'ok')

    def test_waiting_for_renderer_rechecks_freshness_before_using_readings(self):
        owner = self
        class WaitingLock:
            def __enter__(self):
                owner.now += 3
            def __exit__(self, *args):
                return False
        self.now += 14
        self.app.render_lock = WaitingLock()
        self.app.renderer.render = Mock()
        with patch('server.time.time', side_effect=lambda: self.now):
            with self.assertRaises(APIError) as caught:
                self.app.preview(self.doc, live=True)
        self.assertEqual(caught.exception.status, 503)
        self.app.renderer.render.assert_not_called()

    def test_expired_or_stopped_runtime_during_render_cannot_return_live_png(self):
        for path in ('expire', 'stop'):
            self.now = 1000
            atomic_write(self.paths.status, json.dumps({'pid': self.pid, 'processStart': self.start}).encode())
            def render(document, stats, palette):
                if path == 'expire':
                    self.now += 16
                else:
                    atomic_write(self.paths.status, b'{}')
                return Image.new('RGB', (10, 10))
            self.app.renderer.render = render
            with patch('server.time.time', side_effect=lambda: self.now):
                with self.assertRaises(APIError) as caught:
                    self.app.preview(self.doc, live=True)
            self.assertEqual(caught.exception.status, 503)

    def test_old_runtime_rejects_false_and_true_trend_fields_before_any_write(self):
        original = self.paths.layout.read_bytes()
        expected = self.app.layout()['revision']
        for trend in (False, True):
            document = deepcopy(self.doc)
            document['widgets'][0]['settings']['trend'] = trend
            with self.assertRaises(APIError) as caught:
                self.app.save(document, expected)
            self.assertEqual(caught.exception.status, 409)
            self.assertEqual(self.paths.layout.read_bytes(), original)
            self.assertFalse(self.paths.older_configs.exists())
