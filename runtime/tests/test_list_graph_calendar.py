"""List, graph and calendar cards: live content and PIL pixels, without collectors."""

import datetime
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from turzx_studio.calendar_display import calendar_geometry, panel_date
from turzx_studio.layout import parse_layout, validate_layout
from turzx_studio.list_display import list_layout
from turzx_studio.renderer import LayoutRenderer, rendered_content

SAMPLE = Path(__file__).resolve().parents[2] / 'public' / 'sample-layout.json'
ROWS = [{'source': 'cpu', 'label': 'CPU', 'value': '24', 'unit': '%'},
        {'source': 'gpu-temperature', 'label': 'GPU temp', 'value': '55', 'unit': '°C'},
        {'source': 'network-down', 'label': 'Download', 'value': '640', 'unit': 'KB/s'}]


def hex_rgb(color):
    return tuple(int(color[index:index + 2], 16) for index in (1, 3, 5))


class ListGraphCalendarTests(unittest.TestCase):
    def setUp(self):
        self.doc = parse_layout(SAMPLE.read_text())
        self.palette = self.doc['palette']
        self.renderer = LayoutRenderer()

    def render(self, widget, stats=None):
        doc = {**self.doc, 'chrome': 'none', 'widgets': [{'id': 'card', 'x': 0, 'y': 0, **widget}]}
        return self.renderer.render(doc, stats=stats)

    def test_list_rows_take_live_readings_and_keep_samples_offline(self):
        widget = {'type': 'list', 'settings': {'label': 'System', 'rows': ROWS, 'bars': True}}
        self.assertEqual(rendered_content(widget), widget['settings'])
        stats = SimpleNamespace(cpu_percent=61.5, gpu_temp=None, net_down_kbps=2048)
        rows = rendered_content(widget, stats)['rows']
        self.assertEqual([(row['value'], row['unit']) for row in rows], [('62', '%'), ('—', '°C'), ('2.0', 'MB/s')])
        self.assertEqual([row['label'] for row in rows], ['CPU', 'GPU temp', 'Download'])

    def test_list_bars_fill_with_primary_and_secondary_for_temperatures(self):
        widget = {'type': 'list', 'width': 352, 'height': 304, 'settings': {'label': 'System', 'rows': ROWS, 'bars': True}}
        image = self.render(widget)
        layout = list_layout(352, 304, 'System', ROWS, True)
        cpu, temperature, network = layout['rows']
        left, right = layout['padding'], 352 - layout['padding']
        filled = round((right - left) * .24)
        self.assertEqual(image.getpixel((left + filled // 2, cpu['barY'] + 3)), hex_rgb(self.palette['primary']))
        self.assertEqual(image.getpixel((left + filled + 8, cpu['barY'] + 3)), hex_rgb(self.palette['outline']))
        self.assertEqual(image.getpixel((left + 20, temperature['barY'] + 3)), hex_rgb(self.palette['secondary']))
        self.assertIsNone(network['barY'])

    def test_graph_draws_demo_offline_and_history_live(self):
        widget = {'type': 'graph', 'width': 564, 'height': 304,
                  'settings': {'label': 'Network', 'style': 'area', 'sources': ['network-down', 'network-up']}}
        demo = self.render(widget)
        empty = self.render(widget, SimpleNamespace(studio_history={}))
        live = self.render(widget, SimpleNamespace(studio_history={'network-down': [100, 400, 300], 'network-up': [None, 20, 50]}))
        self.assertNotEqual(demo.tobytes(), empty.tobytes())
        self.assertNotEqual(live.tobytes(), empty.tobytes())
        # The newest download reading sits under a primary dot at the right edge.
        self.assertEqual(live.getpixel((535, 256 - round(300 / 400 * 112))), hex_rgb(self.palette['primary']))
        line = self.render({**widget, 'settings': {**widget['settings'], 'style': 'line'}})
        self.assertNotEqual(line.tobytes(), demo.tobytes())

    def test_calendar_highlights_today_from_sample_or_panel_clock(self):
        widget = {'type': 'calendar', 'width': 352, 'height': 328,
                  'settings': {'label': 'Calendar', 'source': 'clock', 'weekStart': 'monday'}}
        self.assertEqual(rendered_content(widget)['date'], '2026-10-06')
        stats = SimpleNamespace(clock='Wed 14 Oct  23:12')
        self.assertEqual(rendered_content(widget, stats, today=datetime.date(2026, 10, 14))['date'], '2026-10-14')
        self.assertIsNone(rendered_content(widget, SimpleNamespace(clock=''))['date'])
        g = calendar_geometry(352, 328, 'Calendar', 5)
        sample = self.render(widget)
        # 6 October 2026 is a Tuesday: second column, second week.
        today = (g['gridLeft'] + g['cellWidth'] + 5, g['gridTop'] + g['cellHeight'] + 5)
        self.assertEqual(sample.getpixel(today), hex_rgb(self.palette['primary']))
        live = self.render(widget, stats)
        self.assertEqual(live.getpixel(today), hex_rgb(self.palette['surface']))
        unavailable = self.render(widget, SimpleNamespace(clock='—'))
        self.assertEqual(unavailable.getpixel(today), hex_rgb(self.palette['surface']))

    def test_panel_date_takes_the_nearest_year(self):
        self.assertEqual(panel_date('Thu 31 Dec  23:59', datetime.date(2027, 1, 1)), '2026-12-31')
        self.assertEqual(panel_date('Fri 01 Jan  00:00', datetime.date(2026, 12, 31)), '2027-01-01')
        self.assertEqual(panel_date('Thu 29 Feb  09:00', datetime.date(2027, 3, 1)), '2028-02-29')
        self.assertIsNone(panel_date('Sun 29 Feb  09:00', datetime.date(2026, 3, 1)))
        self.assertIsNone(panel_date('Mi 14 Okt  10:00', datetime.date(2026, 10, 14)))

    def test_tiny_cards_clip_without_failing(self):
        for widget in ({'type': 'list', 'settings': {'label': '', 'rows': ROWS, 'bars': True}},
                       {'type': 'graph', 'settings': {'label': 'x', 'style': 'area', 'sources': ['cpu']}},
                       {'type': 'calendar', 'settings': {'label': '', 'source': 'sample', 'weekStart': 'sunday'}}):
            for size in ((1, 1), (40, 30), (120, 90)):
                self.render({**widget, 'width': size[0], 'height': size[1]})

    def test_unknown_types_never_fall_back_to_a_gauge(self):
        original = validate_layout
        unknown = {'id': 'x', 'type': 'dial', 'x': 0, 'y': 0, 'width': 10, 'height': 10, 'settings': {}}
        with patch('turzx_studio.renderer.validate_layout', lambda document: {**original(document), 'widgets': [unknown]}):
            with self.assertRaisesRegex(ValueError, 'dial cards have no panel renderer'):
                self.renderer.render(self.doc)

if __name__ == '__main__':
    unittest.main()
