from copy import deepcopy
import unittest

from turzx_studio.usage_display import usage_content, UsageStats


class UsageDisplayTests(unittest.TestCase):
    def setUp(self):
        self.widget = {'type': 'metric', 'settings': {'label': 'Usage', 'value': '123', 'unit': 'tokens', 'detail': 'Demo', 'source': 'codex-tokens'}}
        self.snapshot = {'servedAt': '2026-10-06T20:00:00Z', 'providers': {
            'codex': {'total': 2_400_000, 'costUSD': 12.5, 'costKind': 'estimate', 'perModel': [{'model': 'gpt-6.1-sol'}],
                      'freshness': {'tokens': {'observedAt': '2026-10-06T19:59:00Z', 'stale': False}},
                      'limits': [{'id': 'primary', 'label': 'Weekly', 'windowMinutes': 10080, 'usedPercent': 41,
                                  'observedAt': '2026-10-06T19:59:00Z', 'resetsAt': '2026-10-06T22:05:00Z', 'stale': False}]},
            'claude': {'total': 10, 'limits': [], 'freshness': {}}}}

    def show(self, source, kind='metric', snapshot=None):
        widget = deepcopy(self.widget)
        widget['settings']['source'] = source
        widget['type'] = kind
        return usage_content(widget, self.snapshot if snapshot is None else snapshot)

    def test_tokens_are_compact_and_snapshot_is_unchanged(self):
        before = deepcopy(self.snapshot)
        result = self.show('codex-tokens')
        self.assertEqual((result['value'], result['unit']), ('2.4', 'M tokens'))
        self.assertIn('UTC today', result['detail'])
        self.assertEqual(before, self.snapshot)

    def test_cost_never_implies_a_subscription_bill(self):
        self.assertIn('API estimate', self.show('codex-cost')['detail'])
        self.snapshot['providers']['codex']['costUSD'] = None
        result = self.show('codex-cost')
        self.assertEqual(result['value'], '—')
        self.assertIn('unavailable', result['detail'])

    def test_weekly_gauge_and_reset_use_provider_window(self):
        result = self.show('codex-weekly', 'gauge')
        self.assertEqual(result['value'], 41)
        self.assertIn('Weekly', result['detail'])
        self.assertEqual(self.show('codex-reset')['value'], '2h 05m')
        self.assertIsNone(self.show('claude-session', 'gauge')['value'])

    def test_elapsed_reset_does_not_invent_fresh_allowance(self):
        self.snapshot['servedAt'] = '2026-10-06T23:00:00Z'
        result = self.show('codex-reset')
        self.assertEqual(result['value'], 'Unconfirmed')
        self.assertIn('awaiting provider', result['detail'])

    def test_secondary_weekly_window_drives_both_reading_and_countdown(self):
        self.snapshot['providers']['codex']['limits'][0]['id'] = 'secondary'
        self.assertEqual(self.show('codex-weekly', 'gauge')['value'], 41)
        self.assertEqual(self.show('codex-reset')['value'], '2h 05m')
        older = deepcopy(self.snapshot['providers']['codex']['limits'][0])
        older.update(id='primary', observedAt='2026-10-06T19:00:00Z', resetsAt='2026-10-07T23:00:00Z')
        self.snapshot['providers']['codex']['limits'].append(older)
        self.assertEqual(self.show('codex-reset')['value'], '2h 05m')

    def test_estimates_honor_pricing_freshness_but_reported_costs_do_not_depend_on_rates(self):
        provider = self.snapshot['providers']['codex']
        provider['freshness']['pricing'] = {'stale': True, 'status': 'stale'}
        self.assertIn('API estimate · stale', self.show('codex-cost')['detail'])
        provider['costKind'] = 'reported'
        self.assertIn('Reported API cost · cached', self.show('codex-cost')['detail'])

    def test_token_gauges_keep_raw_value_and_raw_range_units(self):
        for provider, total in [('codex', 2_400_000), ('claude', 2400)]:
            self.snapshot['providers'][provider]['total'] = total
            result = self.show(provider + '-tokens', 'gauge')
            self.assertEqual((result['value'], result['unit']), (total, 'tokens'))

    def test_stale_values_are_labeled_and_absent_values_do_not_reuse_demo(self):
        self.snapshot['providers']['codex']['freshness']['tokens']['stale'] = True
        self.assertTrue(self.show('codex-tokens')['detail'].startswith('Stale'))
        self.assertEqual(self.show('codex-tokens', snapshot={})['value'], '—')
        self.assertIsNone(self.show('codex-weekly', 'gauge', snapshot={})['value'])

    def test_storage_reports_available_free_space(self):
        self.snapshot['storage'] = {'usedPercent': 60, 'usedGiB': 60, 'freeGiB': 35, 'totalGiB': 100}
        result = self.show('storage', 'gauge')
        self.assertEqual(result['value'], 60)
        self.assertIn('35.0 free', result['detail'])
        self.assertIn('60.0/100 GiB used', result['detail'])

    def test_wrapper_preserves_original_stats(self):
        class Stats:
            cpu_percent = 24
        stats = Stats()
        wrapped = UsageStats(stats, self.snapshot)
        self.assertEqual(wrapped.cpu_percent, 24)
        self.assertIs(wrapped.ai_usage, self.snapshot)
        self.assertFalse(hasattr(stats, 'ai_usage'))

    def test_other_sources_are_left_to_existing_renderer(self):
        self.assertIsNone(self.show('cpu'))

    def test_model_rows_show_tokens_and_complete_costs_without_substituting_partial_costs(self):
        provider = self.snapshot['providers']['codex']
        provider['perModel'] = [
            {'model': 'gpt-6.1-sol', 'total': 2_400_000, 'costUSD': 12.5, 'costKind': 'estimate'},
            {'model': 'unknown', 'total': 2400, 'costUSD': None, 'knownCostUSD': 1.5, 'costKind': 'unavailable'},
        ]
        result = self.show('codex-models')
        self.assertEqual(result['value'], '2')
        self.assertIn('gpt-6.1-sol\t2.4M\t12.50', result['detail'])
        self.assertIn('unknown\t2.4K\t—', result['detail'])
        self.assertIn('API est.', result['detail'])


if __name__ == '__main__':
    unittest.main()
