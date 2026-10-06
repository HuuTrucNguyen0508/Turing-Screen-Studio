"""Agent-facing commands generate offline and preserve revisions when saving."""

from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch

import layout_cli
import server
from turzx_studio.layout import parse_layout, revision
from turzx_studio.storage import Paths

ROOT = Path(__file__).resolve().parents[2]


class LayoutCLITests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def command(self, *args):
        return subprocess.run([sys.executable, str(ROOT / 'runtime/layout_cli.py'), *map(str, args)],
                              cwd=ROOT, capture_output=True, text=True, timeout=20)

    def test_catalog_templates_expand_and_invalid_specs_do_not_write(self):
        for template in layout_cli.catalog()['widgets']:
            with self.subTest(template=template['id']):
                document = layout_cli.generate({'widgets': [{'template': template['id']}]})
                self.assertEqual(document['widgets'][0]['settings'], template['settings'])
        for spec in ({'widgets': [{'template': 'not-a-widget'}]},
                     {'widgets': [{'template': 'cpu', 'x': 1279}]},
                     {'widgets': [{'template': 'clock', 'settings': {'format': 'invalid'}}]},
                     {'widgets': [{'template': 'gauge', 'settings': {'min': 100, 'max': 0}}]},
                     {'widgets': [], 'unsupported': True}):
            with self.assertRaises(ValueError):
                layout_cli.generate(spec)

    def test_catalog_search_and_groups_find_variants_offline(self):
        result = self.command('catalog', '--search', 'WIDE', '--group', 'network')
        self.assertEqual(result.returncode, 0, result.stderr)
        choices = json.loads(result.stdout)
        self.assertEqual({item['id'] for item in choices['widgets']},
                         {'network-down-wide', 'network-up-wide'})
        self.assertEqual([item['id'] for item in layout_cli.browse_catalog(' CPU WIDE ', 'system')['widgets']],
                         ['cpu-wide'])
        gauges = layout_cli.browse_catalog('cpu', 'gauge')['widgets']
        self.assertEqual({item['settings']['style'] if 'style' in item['settings'] else 'arc' for item in gauges},
                         {'arc', 'ring', 'bar', 'segments', 'number', 'thermometer'})
        self.assertNotIn('gauge', {item['id'] for item in gauges})
        for item in gauges:
            document = layout_cli.generate({'widgets': [{'template': item['id']}]})
            self.assertEqual(document['widgets'][0]['type'], 'gauge')
            self.assertEqual(document['widgets'][0]['settings']['source'], item['settings']['source'])
        self.assertEqual(layout_cli.browse_catalog('no matching widget')['widgets'], [])
        result = self.command('catalog', '--group', 'missing')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Unknown widget group', result.stderr)

    def test_generate_spec_validate_and_preview_are_offline(self):
        spec = self.root / 'spec.json'
        spec.write_text(json.dumps({'name': 'My desk', 'widgets': [
            {'template': 'clock', 'x': 64, 'y': 160},
            {'template': 'text', 'x': 440, 'y': 160, 'settings': {'text': 'Focus on the next task.'}}]}))
        output = self.root / 'layout.json'
        result = self.command('generate', '--spec', spec, '--output', output)
        self.assertEqual(result.returncode, 0, result.stderr)
        document = parse_layout(output.read_text())
        self.assertEqual(document['widgets'][1]['settings']['text'], 'Focus on the next task.')
        result = self.command('validate', output, '--panel')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['overlaps'], [])
        image = self.root / 'preview.png'
        result = self.command('preview', output, '--output', image)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(image.read_bytes()[:8], b'\x89PNG\r\n\x1a\n')

    def test_all_designed_presets_validate_without_overlaps(self):
        for preset in layout_cli.presets()['presets']:
            with self.subTest(preset=preset['id']):
                output = self.root / (preset['id'] + '.json')
                result = self.command('generate', '--preset', preset['id'], '--output', output)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(layout_cli.summary(parse_layout(output.read_text(), panel=True))['overlaps'], [])

    def test_invalid_json_and_missing_revision_fail_before_panel_save(self):
        bad = self.root / 'bad.json'
        bad.write_text('{"version":1,"version":1}')
        result = self.command('validate', bad)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('duplicate', result.stderr)
        result = self.command('apply', ROOT / 'public/sample-layout.json')
        self.assertEqual(result.returncode, 2)
        self.assertIn('--if-match', result.stderr)
        for base in ('https://example.com', 'http://example.com', 'http://user:password@localhost:5174', 'http://localhost:5174/path'):
            with self.assertRaises(ValueError):
                layout_cli.api(base, '/api/layout')

    def test_apply_conflict_and_restore_use_real_local_api_with_archiving(self):
        paths = Paths(self.root / 'state', self.root / 'runtime')
        app = server.StudioApplication(paths)
        httpd = server.StudioHTTPServer(app, 0)
        thread = threading.Thread(target=httpd.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        thread.start()
        def stop():
            httpd.shutdown(); httpd.server_close(); thread.join(timeout=3)
        self.addCleanup(stop)
        base = f'http://127.0.0.1:{httpd.server_port}'
        original = app.layout()
        changed = deepcopy(original['document']); changed['name'] = 'AI layout'
        output = self.root / 'ai.json'; layout_cli.write_layout(output, changed)
        result = self.command('--url', base, 'apply', output, '--if-match', original['revision'], '--wait', 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        applied = json.loads(result.stdout)
        self.assertIsNotNone(applied['archive'])
        result = self.command('--url', base, 'apply', output, '--if-match', original['revision'], '--wait', 0)
        self.assertEqual(result.returncode, 1)
        self.assertIn('409', result.stderr)
        result = self.command('--url', base, 'restore', applied['archive']['id'], '--if-match', applied['revision'], '--wait', 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(app.layout()['document'], original['document'])
        history = layout_cli.api(base, '/api/history')['archives']
        self.assertEqual(len(history), 2)

    def test_saved_and_rotation_commands_use_guarded_local_api(self):
        paths = Paths(self.root / 'state', self.root / 'runtime')
        app = server.StudioApplication(paths)
        httpd = server.StudioHTTPServer(app, 0)
        thread = threading.Thread(target=httpd.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        thread.start()
        def stop():
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=3)
        self.addCleanup(stop)
        base = f'http://127.0.0.1:{httpd.server_port}'
        original = paths.layout.read_bytes()
        result = self.command('--url', base, 'saved')
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads(result.stdout)
        self.assertEqual([entry['id'] for entry in saved['entries']],
                         ['current', 'system-overview', 'ai-usage', 'focus'])
        self.assertEqual(paths.layout.read_bytes(), original)
        self.assertFalse(paths.older_configs.exists())
        for command, expected in ((('next',), 'system-overview'), (('previous',), 'current'),
                                  (('use', 'ai-usage'), 'ai-usage'), (('slot', 4), 'focus')):
            result = self.command('--url', base, *command)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['activeId'], expected)
            self.assertEqual(app.layouts()['activeId'], expected)
        current = app.layout()
        for command in (('next', '--if-match', saved['revision']), ('use', 'missing'),
                        ('slot', 5), ('slot', 0), ('slot', 13)):
            result = self.command('--url', base, *command)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertEqual(app.layout(), current)

    def test_slot_initializes_missing_library_and_then_switches_without_prior_saved_command(self):
        paths = Paths(self.root / 'state', self.root / 'runtime')
        app = server.StudioApplication(paths)
        httpd = server.StudioHTTPServer(app, 0)
        thread = threading.Thread(target=httpd.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        thread.start()
        def stop():
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=3)
        self.addCleanup(stop)
        base = f'http://127.0.0.1:{httpd.server_port}'
        original = app.layout()
        self.assertFalse(app.library.path.exists())
        result = self.command('--url', base, 'slot', 3)
        self.assertEqual(result.returncode, 0, result.stderr)
        switched = json.loads(result.stdout)
        self.assertEqual(switched['activeId'], 'ai-usage')
        self.assertEqual(app.layouts()['entries'][0]['document'], original['document'])
        self.assertEqual(switched['archive']['revision'], original['revision'])

    def test_switch_reads_latest_revision_and_does_not_retry_conflicts(self):
        def reply(base, path, document=None, if_match=None):
            if path == '/api/layouts':
                return {'entries': [], 'revision': 'library'}
            if path == '/api/layout':
                return {'revision': 'latest'}
            raise ValueError('Studio HTTP 409: Saved layout changed')
        with patch('layout_cli.api', side_effect=reply) as api:
            with self.assertRaisesRegex(ValueError, '409'):
                layout_cli.switch('http://127.0.0.1:5174', {'slot': 2})
            self.assertEqual([call.args[1] for call in api.call_args_list],
                             ['/api/layouts', '/api/layout', '/api/layouts/switch'])
            self.assertEqual(api.call_args_list[-1].args[2:], ({'slot': 2}, 'latest'))
        with patch('layout_cli.api', side_effect=reply) as api:
            with self.assertRaisesRegex(ValueError, '409'):
                layout_cli.switch('http://127.0.0.1:5174', {'id': 'current'}, 'override')
            self.assertEqual(api.call_args_list[-1].args[2:], ({'id': 'current'}, 'override'))


if __name__ == '__main__':
    unittest.main()
