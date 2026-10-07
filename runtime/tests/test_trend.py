"""Trend contract and PIL history rendering, without live services or collectors."""

from copy import deepcopy
import hashlib
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image, ImageChops, ImageDraw

from turzx_studio.layout import parse_layout, serialize_layout, validate_layout
from turzx_studio.renderer import LayoutRenderer, rendered_content
from turzx_studio.trend import demo_trend_history, trend_chart, trend_history, widget_trend

SAMPLE = Path(__file__).resolve().parents[2] / 'public' / 'sample-layout.json'


class TrendTests(unittest.TestCase):
    def setUp(self):
        self.doc = parse_layout(SAMPLE.read_text())
        self.widget = deepcopy(self.doc['widgets'][0])
        self.widget.update(width=352, height=304)
        self.widget['settings'].update(source='cpu', trend=True)
        self.renderer = LayoutRenderer()

    def test_legacy_bytes_pixels_and_explicit_false_are_unchanged(self):
        self.assertEqual(serialize_layout(self.doc), SAMPLE.read_text())
        pixels = self.renderer.render(self.doc).tobytes()
        self.assertEqual(hashlib.sha256(pixels).hexdigest(), 'cfc7a95c0cc69d89153815f8a9a9ad01d66b314e39e449c4ec473eaddbaa4620')
        self.doc['widgets'][0]['settings']['trend'] = False
        self.assertEqual(self.renderer.render(self.doc).tobytes(), pixels)

    def test_optional_settings_are_strict_detached_and_round_trip(self):
        for flag in (True, False):
            self.widget['settings']['trend'] = flag
            doc = {**self.doc, 'widgets': [self.widget]}
            self.assertEqual(parse_layout(serialize_layout(doc)), doc)
            self.assertIsNot(validate_layout(doc)['widgets'][0]['settings'], self.widget['settings'])
        for flag in (None, 0, 1, 'true', [], {}):
            self.widget['settings']['trend'] = flag
            with self.subTest(flag=flag), self.assertRaisesRegex(ValueError, r'settings.trend: expected a boolean'):
                validate_layout({**self.doc, 'widgets': [self.widget]})

    def test_history_cap_and_invalid_slots_preserve_null_gaps(self):
        self.assertEqual(trend_history([None, True, '2', float('inf'), float('nan'), 10**400, 0]), [None] * 6 + [0])
        self.assertEqual(trend_history(list(range(140))), list(range(20, 140)))
        self.assertEqual(trend_history(None), [])
        chart = trend_chart('cpu', [0, 100, None, 20, 40], 352, 304)
        self.assertEqual([len(points) for points in chart['segments']], [2, 2])
        self.assertEqual(chart['segments'][0][0]['y'], chart['bottom'])
        self.assertEqual(chart['segments'][0][1]['y'], chart['top'])
        self.assertEqual(trend_chart('network-down', [0, 2048], 352, 304)['max'], 2048)
        self.assertEqual(trend_chart('cpu-temperature', [-5, 40], 352, 304)['min'], -5)

    def test_stats_supplied_never_reuse_sample_or_legacy_history(self):
        for stats in (SimpleNamespace(), SimpleNamespace(cpu_history=[24] * 60),
                      SimpleNamespace(studio_history={'gpu': [18] * 120}),
                      SimpleNamespace(studio_history=None)):
            chart, caption = widget_trend(self.widget['settings'], stats, 352, 304)
            self.assertEqual(chart['segments'], [])
            self.assertEqual(chart['state'], 'No history yet')
            self.assertEqual(caption, 'Last 120 readings · Observed')
        self.widget['settings']['source'] = 'sample'
        self.assertEqual(widget_trend(self.widget['settings'], SimpleNamespace(), 352, 304)[0]['segments'], [])
        self.assertEqual(len(demo_trend_history('cpu')), 120)
        self.assertEqual(demo_trend_history('unknown'), [])

    def test_caption_describes_readings_not_elapsed_time_or_poll_frequency(self):
        for stats, mode in ((None, 'Demo'), (SimpleNamespace(studio_history={'cpu': [10, None, 30]}), 'Observed')):
            chart, caption = widget_trend(self.widget['settings'], stats, 352, 304)
            self.assertEqual(caption, f'Last 120 readings · {mode}')
            self.assertNotRegex(caption, 'minute|second')
            if stats is not None:
                self.assertEqual(chart['count'], 2)
                self.assertEqual([points[0]['x'] for points in chart['segments']], [318, 323])

    def test_pil_draws_separate_observed_lines_and_only_uses_studio_history(self):
        settings = self.widget['settings']
        stats = SimpleNamespace(cpu_percent=55, cpu_history=[99] * 120,
                                studio_history={'cpu': [10, 20, None, 30, 40]})
        chart, _ = widget_trend(settings, stats, 352, 304)
        draw = ImageDraw.Draw(Image.new('RGB', (352, 304)))
        with patch.object(draw, 'line', wraps=draw.line) as lines:
            self.renderer._metric(draw, 352, 304, settings, self.doc['palette'], stats)
            primary = [call.args[0] for call in lines.call_args_list if call.kwargs.get('fill') == self.doc['palette']['primary']]
        self.assertEqual(primary, [[(point['x'], point['y']) for point in points] for points in chart['segments']])
        self.assertEqual(len(primary), 2)
        self.assertEqual(rendered_content(self.widget, stats)['value'], '55')

    def test_empty_and_single_observation_have_truthful_caption_and_state(self):
        for history, state in (([], 'No history yet'), ([None, None], 'No history yet'),
                               ([20], 'Collecting history'), ([10, None, 20], 'Collecting history')):
            draw = ImageDraw.Draw(Image.new('RGB', (352, 304)))
            stats = SimpleNamespace(studio_history={'cpu': history})
            with patch.object(self.renderer, '_draw_text', wraps=self.renderer._draw_text) as text:
                self.renderer._metric(draw, 352, 304, self.widget['settings'], self.doc['palette'], stats)
            values = [call.args[2] for call in text.call_args_list]
            self.assertIn(state, values)
            self.assertIn('Last 120 readings · Observed', values)

    def test_real_history_changes_pixels_and_does_not_mutate_inputs(self):
        doc = {**self.doc, 'widgets': [self.widget]}
        stats = SimpleNamespace(cpu_percent=24, studio_history={'cpu': [0, None, 100] * 40})
        original = deepcopy((doc, vars(stats)))
        first = self.renderer.render(doc, stats)
        stats.studio_history['cpu'] = [100, None, 0] * 40
        second = self.renderer.render(doc, stats)
        self.assertNotEqual(first.tobytes(), second.tobytes())
        stats.studio_history['cpu'] = original[1]['studio_history']['cpu']
        self.assertEqual((doc, vars(stats)), original)
        self.assertEqual(first.tobytes(), self.renderer.render(doc, stats).tobytes())

    def test_tiny_and_compact_cards_clip_pixels(self):
        base = self.renderer.render({**self.doc, 'widgets': []})
        for width, height in ((1, 1), (17, 1), (1, 17), (120, 80), (352, 224), (352, 304)):
            widget = {**self.widget, 'x': 10, 'y': 200, 'width': width, 'height': height}
            image = self.renderer.render({**self.doc, 'widgets': [widget]})
            difference = ImageChops.difference(base, image).getbbox()
            self.assertGreaterEqual(difference[0], 10)
            self.assertGreaterEqual(difference[1], 200)
            self.assertLessEqual(difference[2], 10 + width)
            self.assertLessEqual(difference[3], 200 + height)


if __name__ == '__main__':
    unittest.main()
