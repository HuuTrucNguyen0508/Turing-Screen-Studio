import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from turzx_studio.layout import validate_layout
from turzx_studio.renderer import LayoutRenderer, rendered_content
from turzx_studio.usage_display import UsageStats

ROOT = Path(__file__).resolve().parents[2]


class UsageRendererTests(unittest.TestCase):
    def test_clean_layouts_render_dynamic_rows_without_header_or_footer(self):
        document = json.loads((ROOT / 'layouts/ai-usage-30d.json').read_text())
        stats = UsageStats(SimpleNamespace(), {'servedAt': '2026-10-07T10:00:00Z', 'providers': {
            'codex': {'quotaWindows': {'five_hour': 'unsupported'}, 'limits': [
                {'id': 'primary', 'windowMinutes': 10080, 'usedPercent': 10, 'resetsAt': '2026-10-14T10:00:00Z', 'stale': False}]},
            'claude': {'limits': [{'windowMinutes': 300, 'usedPercent': 100, 'resetsAt': '2026-10-07T09:00:00Z'}]},
        }})
        renderer = LayoutRenderer()
        with patch.object(renderer, '_draw_text', wraps=renderer._draw_text) as draw:
            image = renderer.render(document, stats)
            texts = [call.args[2] for call in draw.call_args_list]
        self.assertEqual(image.size, (1280, 800))
        self.assertNotIn('TURZX / desktop', texts)
        self.assertNotIn('Live dashboard', texts)
        self.assertNotIn('100', texts)
        self.assertIn('90', texts)
        self.assertIn('Usage limits · Usage left', texts)
        self.assertIn('Cursor', texts)
        self.assertIn('—', texts)
        image.close()
    def test_quota_remaining_bar_and_text_cover_zero_full_unknown_and_expired(self):
        document = json.loads((ROOT / 'layouts/ai-usage-30d.json').read_text())
        document['widgets'] = [next(widget for widget in document['widgets'] if widget['id'] == 'usage-limits')]
        renderer = LayoutRenderer()
        for used, reset, expected in [(0, 'resets 6d', '100'), (41, 'resets 6d', '59'),
                                      (100, 'resets 6d', '0'), ('-', 'reset unavailable', '—'),
                                      (100, 'reset time passed', '—')]:
            with self.subTest(used=used, reset=reset):
                document['widgets'][0]['settings']['detail'] = f'Cached quotas\nCodex\tWeekly\t{used}\t{reset}\tcached'
                with patch.object(renderer, '_draw_text', wraps=renderer._draw_text) as draw:
                    image = renderer.render(document)
                    percentages = [call.args[2] for call in draw.call_args_list if call.args[4] == 24]
                self.assertEqual(percentages, [expected])
                image.close()

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
