from copy import deepcopy
import json
from types import SimpleNamespace
import unittest

from turzx_studio.dashboard_display import DashboardStats, dashboard_content


def widget(source):
    return {'type': 'metric', 'settings': {'source': source, 'label': 'Demo', 'value': '99', 'unit': '', 'detail': 'Sample'}}


class DashboardDisplayTests(unittest.TestCase):
    def test_live_activity_does_not_reuse_demo_or_mutate_inputs(self):
        card = widget('t3-threads')
        snapshot = {'working': 1, 'status': 'live', 'threads': [{'title': 'Build\nnow', 'provider': 'Codex', 'status': 'running'}]}
        before = deepcopy((card, snapshot))
        shown = dashboard_content(card, DashboardStats(None, activity=snapshot))
        self.assertEqual(shown['value'], '1')
        self.assertEqual(json.loads(shown['detail'])['threads'][0]['title'], 'Build now')
        self.assertEqual((card, snapshot), before)

    def test_idle_and_unavailable_are_distinct(self):
        for status, count, expected in [('live', 0, '0'), ('stale', 3, '—'), ('unavailable', None, '—'), ('live', True, '—')]:
            shown = dashboard_content(widget('t3-threads'), DashboardStats(None, {'status': status, 'working': count, 'threads': []}))
            self.assertEqual(shown['value'], expected)

    def test_timer_counts_and_countdown_are_bounded_and_explicit(self):
        snapshot = {'games': [
            {'id': 'genshin', 'current': 120, 'capacity': 200, 'status': 'estimate', 'fullAt': '2026-10-07T02:01:01Z'},
            {'id': 'wuwa', 'current': 300, 'capacity': 240, 'status': 'full', 'fullAt': None},
            {'id': 'zzz', 'current': 0, 'capacity': 240, 'status': 'not-configured', 'fullAt': None},
        ]}
        rows = json.loads(dashboard_content(widget('game-resources'), DashboardStats(None, games=snapshot), now=1791338400)['detail'])['games']
        self.assertEqual(rows[0]['current'], 120)
        self.assertEqual(rows[1]['current'], 300)
        self.assertEqual(rows[1]['remaining'], 'Above cap')
        self.assertIsNone(rows[2]['current'])
        self.assertIn('Game timers', rows[2]['remaining'])

    def test_missing_games_remain_unknown_and_samples_are_preserved_offline(self):
        card = widget('game-resources')
        self.assertEqual(dashboard_content(card), card['settings'])
        rows = json.loads(dashboard_content(card, SimpleNamespace())['detail'])['games']
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row['current'] is None for row in rows))

    def test_future_timer_explains_the_clock_problem_without_a_count(self):
        snapshot = {'games': [{'id': 'genshin', 'status': 'unavailable', 'capacity': 200,
            'current': None, 'note': 'Check timer: set time is ahead.'}]}
        row = json.loads(dashboard_content(widget('game-resources'), DashboardStats(None, games=snapshot))['detail'])['games'][0]
        self.assertIsNone(row['current'])
        self.assertEqual(row['remaining'], 'Check timer · clock ahead')

    def test_stats_proxy_preserves_existing_sensor_attributes(self):
        proxy = DashboardStats(SimpleNamespace(cpu_percent=42))
        self.assertEqual(proxy.cpu_percent, 42)
        self.assertIsNone(proxy.missing)
