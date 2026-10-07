"""Custom templates use independent guarded writes and preserve prior bytes."""
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import server
from turzx_studio.storage import Paths
from turzx_studio.widget_templates import validate_templates


class TemplateTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.paths = Paths(root / 'state', root / 'runtime')
        self.app = server.StudioApplication(self.paths)
        self.panel = self.paths.layout.read_bytes()
        widget = self.app.layout()['document']['widgets'][0]
        self.copy = {'version': 1, 'widgets': [{'id': 'my-cpu', 'name': 'My CPU', 'widget': {
            key: widget[key] for key in ('type', 'width', 'height', 'settings')}}]}

    def error(self, status, call, *args):
        with self.assertRaises(server.APIError) as caught:
            call(*args)
        self.assertEqual(caught.exception.status, status)

    def test_guarded_save_is_independent_and_archives_exact_previous_bytes(self):
        initial = self.app.widgets()
        self.assertFalse((self.paths.state_dir / 'widgets.json').exists())
        self.error(428, self.app.save_widgets, self.copy, None)
        saved = self.app.save_widgets(self.copy, initial['revision'])
        previous = (self.paths.state_dir / 'widgets.json').read_bytes()
        self.error(409, self.app.save_widgets, {'version': 1, 'widgets': []}, initial['revision'])
        self.assertEqual((self.paths.state_dir / 'widgets.json').read_bytes(), previous)
        self.app.save_widgets({'version': 1, 'widgets': []}, saved['revision'])
        archives = list((self.paths.older_configs / 'custom-widgets').glob('*.json'))
        self.assertEqual(len(archives), 1)
        self.assertEqual(archives[0].read_bytes(), previous)
        self.assertEqual(self.paths.layout.read_bytes(), self.panel)
        self.assertFalse((self.paths.state_dir / 'layouts.json').exists())

    def test_archive_failure_preserves_store(self):
        saved = self.app.save_widgets(self.copy, self.app.widgets()['revision'])
        previous = (self.paths.state_dir / 'widgets.json').read_bytes()
        with patch('turzx_studio.widget_templates.atomic_write', side_effect=OSError('archive failed')):
            self.error(500, self.app.save_widgets, {'version': 1, 'widgets': []}, saved['revision'])
        self.assertEqual((self.paths.state_dir / 'widgets.json').read_bytes(), previous)

    def test_corrupt_store_is_preserved_and_cannot_be_overwritten(self):
        path = self.paths.state_dir / 'widgets.json'
        path.write_bytes(b'{broken')
        self.error(422, self.app.widgets)
        self.error(422, self.app.save_widgets, self.copy, 'unknown')
        self.assertEqual(path.read_bytes(), b'{broken')

    def test_validation_rejects_template_geometry_metadata_and_duplicate_names(self):
        for key in ('id', 'x', 'y'):
            bad = deepcopy(self.copy); bad['widgets'][0]['widget'][key] = 0
            with self.assertRaises(ValueError): validate_templates(bad)
        bad = deepcopy(self.copy); bad['widgets'][0]['widget']['width'] = 1281
        with self.assertRaises(ValueError): validate_templates(bad)
        bad = deepcopy(self.copy); second = deepcopy(bad['widgets'][0]); second['id'] = 'other'; second['name'] = 'MY CPU'; bad['widgets'].append(second)
        with self.assertRaises(ValueError): validate_templates(bad)

    def test_noop_save_does_not_add_archive(self):
        saved = self.app.save_widgets(self.copy, self.app.widgets()['revision'])
        self.app.save_widgets(self.copy, saved['revision'])
        self.assertFalse((self.paths.older_configs / 'custom-widgets').exists())

    def test_clock_design_blocked_for_old_runtime_before_archiving_panel(self):
        catalog = json.loads((Path(__file__).resolve().parents[2] / 'public/widget-catalog.json').read_text())
        clock = next(entry for entry in catalog['widgets'] if entry['type'] == 'clock')
        document = self.app.layout()['document']
        document['widgets'] = [{'id': 'clock', 'x': 0, 'y': 0, **{key: clock[key] for key in ('type', 'width', 'height', 'settings')}, 'design': {'elements': {'time': {'align': 'center'}}}}]
        self.paths.runtime_dir.mkdir(parents=True, exist_ok=True)
        import os
        self.paths.status.write_text(json.dumps({'pid': os.getpid(), 'processStart': server.process_start(os.getpid()), 'supportedWidgetTypes': ['clock']}))
        self.error(409, self.app.save, document, self.app.layout()['revision'])
        self.assertEqual(self.paths.layout.read_bytes(), self.panel)
        self.assertFalse(self.paths.older_configs.exists())


    def test_name_boundaries_match_browser_utf16_and_whitespace(self):
        current = self.app.widgets()
        for name in ('😀' * 31, '\ufeff'):
            candidate = deepcopy(self.copy); candidate['widgets'][0]['name'] = name
            self.error(422, self.app.save_widgets, candidate, current['revision'])
            self.assertEqual(self.app.widgets()['revision'], current['revision'])
        candidate = deepcopy(self.copy); candidate['widgets'][0]['name'] = '\ufeff' + '😀' * 30 + '\ufeff'
        saved = self.app.save_widgets(candidate, current['revision'])
        self.assertEqual(saved['widgets'][0]['name'], '😀' * 30)
