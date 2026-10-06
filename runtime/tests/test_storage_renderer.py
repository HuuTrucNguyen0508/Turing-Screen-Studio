import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from turzx_studio.layout import validate_layout
from turzx_studio.renderer import LayoutRenderer, rendered_content
from turzx_studio.storage_display import SAMPLE_STORAGE, storage_content, storage_geometry
from turzx_studio.usage_display import UsageStats

ROOT = Path(__file__).resolve().parents[2]


class MountedStorageRendererTests(unittest.TestCase):
    def setUp(self):
        self.document = json.loads((ROOT / 'public/sample-layout.json').read_text())
        self.document['widgets'] = [dict(id='mounted-storage', type='storage', x=64, y=160, width=564, height=480,
                                         settings=dict(label='Mounted storage', style='bars', source='mounted-storage'))]
        self.widget = self.document['widgets'][0]

    def test_live_rows_are_transient_and_missing_snapshot_has_no_sample_fallback(self):
        before = copy.deepcopy(self.document)
        snapshot = {'mountedStorage': copy.deepcopy(SAMPLE_STORAGE)}
        snapshot['mountedStorage']['mounts'][2]['usedGiB'] = 321
        content = rendered_content(self.widget, UsageStats(SimpleNamespace(), snapshot))
        self.assertEqual(content['mounts'][2]['usedGiB'], 321)
        self.assertFalse(content['sample'])
        self.assertEqual(rendered_content(self.widget, UsageStats(SimpleNamespace(), {}))['mounts'], [])
        self.assertTrue(rendered_content(self.widget)['sample'])
        self.assertEqual(rendered_content(self.widget)['mounts'], SAMPLE_STORAGE['mounts'])
        content['mounts'][0]['aliases'].append('/changed-transient-result')
        self.assertNotIn('/changed-transient-result', snapshot['mountedStorage']['mounts'][0]['aliases'])
        self.assertEqual(self.document, before)
        self.assertEqual(validate_layout(self.document), before)

    def test_failed_filesystem_retains_other_readings_and_exposes_partial_state(self):
        data = copy.deepcopy(SAMPLE_STORAGE)
        data['mounts'][2].update(usedPercent=None, totalGiB=None, usedGiB=None, freeGiB=None, stale=True, errors=['unavailable'])
        data.update(stale=True, errors=['unavailable'])
        result = storage_content(self.widget, {'mountedStorage': data})
        self.assertEqual(len(result['mounts']), 5)
        self.assertEqual(result['mounts'][0]['usedPercent'], 69)
        self.assertIsNone(result['mounts'][2]['usedPercent'])
        image = LayoutRenderer().render(self.document, UsageStats(SimpleNamespace(), {'mountedStorage': data}))
        image.close()

    def test_resizing_reports_hidden_rows_and_both_designs_render_without_discovery(self):
        renderer = LayoutRenderer()
        images = []
        with patch('shutil.disk_usage', side_effect=AssertionError('renderer must not probe drives')):
            for style in ('bars', 'table'):
                self.widget['settings']['style'] = style
                image = renderer.render(self.document)
                images.append(image.tobytes())
                image.close()
            for width, height in ((1,1), (120,100), (200,224), (564,384)):
                self.widget.update(width=width, height=height)
                image = renderer.render(self.document)
                self.assertEqual(image.size, (1280,800))
                image.close()
        self.assertNotEqual(*images)
        self.assertEqual(storage_geometry(352,480,'bars')['capacity'],5)
        self.assertEqual(storage_geometry(564,384,'table')['capacity'],5)
        self.assertEqual(storage_geometry(200,224,'table')['capacity'],1)

    def test_escaped_control_characters_in_mounts_and_labels_render_on_one_line(self):
        data = copy.deepcopy(SAMPLE_STORAGE)
        data['mounts'][2]['mount'] = '/mnt/game\nfolder\tname'
        data['mounts'][0]['aliases'] = ['/home\ruser']
        self.widget['settings']['label'] = 'My\ndrives'
        for style in ('bars', 'table'):
            self.widget['settings']['style'] = style
            image = LayoutRenderer().render(self.document, UsageStats(SimpleNamespace(), {'mountedStorage': data}))
            image.close()

    def test_sample_source_stays_deterministic_with_live_stats(self):
        self.widget['settings']['source'] = 'sample'
        actual = rendered_content(self.widget, UsageStats(SimpleNamespace(), {}))
        self.assertTrue(actual['sample'])
        self.assertEqual(actual['mounts'], SAMPLE_STORAGE['mounts'])


if __name__ == '__main__':
    unittest.main()
