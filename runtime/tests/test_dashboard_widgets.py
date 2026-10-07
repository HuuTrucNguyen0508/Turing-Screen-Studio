from copy import deepcopy
from http.client import HTTPConnection
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import server
from turzx_studio.dashboard_display import DashboardStats
from turzx_studio.layout import validate_layout
from turzx_studio.renderer import LayoutRenderer, rendered_content
from turzx_studio.storage import Paths

ROOT = Path(__file__).resolve().parents[2]


class LocalDashboardHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.paths = Paths(Path(self.temp.name) / 'state', Path(self.temp.name) / 'runtime')
        self.app = server.StudioApplication(self.paths)
        self.http = server.StudioHTTPServer(self.app, 0)
        self.thread = threading.Thread(target=self.http.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join(3)

    def request(self, method, body=None, revision=None, origin=None, path='/api/games'):
        connection = HTTPConnection('127.0.0.1', self.http.server_port, timeout=5)
        headers = {'Host': f'127.0.0.1:{self.http.server_port}'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if revision is not None:
            headers['If-Match'] = revision
        if origin is not None:
            headers['Origin'] = origin
        try:
            connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, dict(response.getheaders()), json.loads(raw) if raw else None
        finally:
            connection.close()

    def test_timer_roundtrip_is_shared_and_preserves_layout_and_archives(self):
        before = self.paths.layout.read_bytes()
        status, headers, initial = self.request('GET')
        self.assertEqual(status, 200)
        self.assertEqual(headers['ETag'], '"' + initial['revision'] + '"')
        self.assertTrue(all(row['current'] is None for row in initial['games']))
        self.assertFalse((self.paths.state_dir / 'game-timers.json').exists())
        status, _, saved = self.request('POST', {'game': 'genshin', 'count': 120}, initial['revision'])
        self.assertEqual(status, 200)
        self.assertEqual(saved['games'][0]['current'], 120)
        self.assertEqual(self.request('GET')[2]['revision'], saved['revision'])
        status, _, cleared = self.request('POST', {'game': 'genshin', 'clear': True}, saved['revision'])
        self.assertEqual(status, 200)
        self.assertIsNone(cleared['games'][0]['current'])
        self.assertEqual(self.paths.layout.read_bytes(), before)
        self.assertFalse(self.paths.older_configs.exists())
        self.assertFalse(self.paths.runtime_dir.exists())

    def test_preconditions_conflicts_and_invalid_counts_do_not_overwrite(self):
        revision = self.request('GET')[2]['revision']
        self.assertEqual(self.request('POST', {'game': 'zzz', 'count': 50})[0], 428)
        self.assertEqual(self.request('POST', {'game': 'zzz', 'count': 50}, 'wrong')[0], 409)
        for invalid in (True, -1, 1.5, 10001, '5'):
            self.assertEqual(self.request('POST', {'game': 'zzz', 'count': invalid}, revision)[0], 422)
        status, _, saved = self.request('POST', {'game': 'zzz', 'count': 300}, revision)
        self.assertEqual(status, 200)
        self.assertEqual(saved['games'][2]['current'], 300)
        self.assertEqual(self.request('POST', {'game': 'wuwa', 'count': 20}, revision)[0], 409)
        self.assertEqual(self.request('GET')[2]['games'][2]['current'], 300)

    def test_corrupt_state_and_cross_origin_writes_preserve_existing_bytes(self):
        path = self.paths.state_dir / 'game-timers.json'
        path.write_bytes(b'corrupt')
        before = path.read_bytes()
        revision = self.request('GET')[2]['revision']
        self.assertEqual(self.request('POST', {'game': 'genshin', 'count': 30}, revision)[0], 422)
        self.assertEqual(self.request('POST', {'game': 'genshin', 'count': 30}, revision, origin='https://example.com')[0], 403)
        self.assertEqual(path.read_bytes(), before)

    def test_activity_endpoint_returns_only_detached_collector_metadata(self):
        activity = {'working': None, 'threads': [], 'status': 'unavailable', 'observedAt': None, 'note': 'Not running'}
        with patch.object(self.app.activity, 'snapshot', return_value=activity):
            status, _, result = self.request('GET', path='/api/activity')
        self.assertEqual(status, 200)
        self.assertEqual(result, activity)

    def test_old_runtime_blocks_new_sources_before_archiving(self):
        doc = json.loads((ROOT / 'layouts/ai-usage-30d.json').read_text())
        self.paths.runtime_dir.mkdir()
        self.paths.status.write_text(json.dumps({'pid': os.getpid(), 'processStart': server.process_start(os.getpid()),
            'supportedChrome': True, 'supportedWidgetTypes': ['metric', 'weather', 'clock'], 'supportedDesignTypes': ['clock'],
            'supportedUsageSources': ['usage-tokens-30d', 'usage-cost-30d', 'usage-limits']}))
        before = self.paths.layout.read_bytes()
        with self.assertRaisesRegex(server.APIError, 'thread or game widgets'):
            self.app.save(doc, self.app.layout()['revision'])
        self.assertEqual(self.paths.layout.read_bytes(), before)
        self.assertFalse(self.paths.older_configs.exists())


class LocalDashboardRenderingTests(unittest.TestCase):
    def test_live_widget_readings_replace_samples_without_changing_document(self):
        doc = json.loads((ROOT / 'layouts/system-overview-clean.json').read_text())
        card = next(row for row in doc['widgets'] if row['id'] == 'game-resources')
        before = deepcopy(card)
        shown = rendered_content(card, DashboardStats(SimpleNamespace()))
        self.assertTrue(all(row['current'] is None for row in json.loads(shown['detail'])['games']))
        self.assertEqual(card, before)
        renderer = LayoutRenderer()
        with patch.object(renderer, '_draw_text', wraps=renderer._draw_text) as text:
            image = renderer.render(doc, stats=DashboardStats(SimpleNamespace()))
            image.close()
        labels = [call.args[2] for call in text.call_args_list]
        self.assertNotIn('137', labels)
        self.assertIn('Estimated', labels)

    def test_new_widgets_render_small_and_large_integer_geometries(self):
        doc = json.loads((ROOT / 'layouts/ai-usage-30d.json').read_text())
        game = next(row for row in json.loads((ROOT / 'layouts/system-overview-clean.json').read_text())['widgets'] if row['id'] == 'game-resources')
        thread = next(row for row in doc['widgets'] if row['id'] == 't3-threads')
        renderer = LayoutRenderer()
        for source in (game, thread):
            for width, height in ((1, 1), (120, 80), (270, 180), (270, 344), (564, 480)):
                card = {**source, 'x': 0, 'y': 0, 'width': width, 'height': height}
                image = renderer.render({**doc, 'widgets': [card]})
                self.assertEqual(image.size, (1280, 800))
                image.close()

    def test_special_sources_reject_gauges_and_trends_in_python_contract(self):
        doc = json.loads((ROOT / 'layouts/ai-usage-30d.json').read_text())
        card = next(row for row in doc['widgets'] if row['id'] == 't3-threads')
        for source in ('t3-threads', 'game-resources'):
            settings = {**card['settings'], 'source': source, 'trend': True}
            with self.assertRaisesRegex(ValueError, 'do not support a trend'):
                validate_layout({**doc, 'widgets': [{**card, 'settings': settings}]})
            gauge = {**card, 'type': 'gauge', 'settings': {'label': 'Local', 'value': 0,
                'min': 0, 'max': 100, 'unit': '', 'detail': '', 'source': source}}
            with self.assertRaisesRegex(ValueError, 'require a metric'):
                validate_layout({**doc, 'widgets': [gauge]})
