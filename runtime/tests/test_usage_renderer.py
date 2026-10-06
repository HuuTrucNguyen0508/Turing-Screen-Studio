import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from turzx_studio.layout import validate_layout
from turzx_studio.renderer import LayoutRenderer, rendered_content
from turzx_studio.usage_display import UsageStats

ROOT = Path(__file__).resolve().parents[2]


class UsageRendererTests(unittest.TestCase):
    def setUp(self):
        self.document = json.loads((ROOT / 'layouts/ai-usage.json').read_text())

    def test_demo_preview_and_missing_live_data_do_not_confuse_readings(self):
        for widget in self.document['widgets']:
            if widget['settings'].get('source', '').startswith(('codex-', 'claude-')):
                self.assertEqual(rendered_content(widget), widget['settings'])
                live = rendered_content(widget, UsageStats(SimpleNamespace(), {}))
                self.assertEqual(live['value'], None if widget['type'] == 'gauge' else '—')

    def test_designed_dashboard_fits_and_renders_with_missing_live_snapshot(self):
        document = validate_layout(self.document, panel=True)
        image = LayoutRenderer().render(document, stats=UsageStats(SimpleNamespace(), {}))
        self.assertEqual(image.size, (1280, 800))
        self.assertEqual(image.mode, 'RGB')
        image.close()

    def test_storage_content_is_from_snapshot_without_changing_document(self):
        catalog = json.loads((ROOT / 'public/widget-catalog.json').read_text())
        entry = next(entry for entry in catalog['widgets'] if entry['id'] == 'storage-ring')
        widget = {'type': entry['type'], 'settings': entry['settings']}
        before = json.dumps(widget)
        stats = UsageStats(SimpleNamespace(), {'storage': {'usedPercent': 63, 'usedGiB': 315, 'freeGiB': 170, 'totalGiB': 500}})
        self.assertEqual(rendered_content(widget, stats)['value'], 63)
        self.assertIn('170.0 free', rendered_content(widget, stats)['detail'])
        self.assertEqual(json.dumps(widget), before)


if __name__ == '__main__':
    unittest.main()
