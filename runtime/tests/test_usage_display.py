from copy import deepcopy
import unittest

from turzx_studio.usage_display import usage_content, UsageStats, USAGE_SOURCES


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

    def test_daily_model_breakdown_keeps_billions_suffix(self):
        self.snapshot['providers']['codex']['perModel'] = [
            {'model': 'gpt-6.1-sol', 'total': 1_200_000_000, 'costUSD': 1, 'costKind': 'reported'}]
        self.assertIn('1.2B', self.show('codex-models')['detail'])

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


class UsageOverviewTests(unittest.TestCase):
    show = UsageDisplayTests.show

    def setUp(self):
        UsageDisplayTests.setUp(self)
        fresh = {'tokens': {'observedAt': '2026-10-06T19:59:00Z', 'stale': False, 'status': 'cached'},
                 'pricing': {'observedAt': '2026-10-06T19:00:00Z', 'stale': False, 'status': 'cached'}}
        self.period = {'scope': {'period': 'last30days'}, 'providers': {
            'codex': {'total': 19_200_000, 'records': 10, 'costUSD': 12.8, 'costKind': 'estimate',
                      'knownCostUSD': 12.8, 'estimatedRecords': 10, 'reportedRecords': 0, 'unpricedRecords': 0,
                      'perModel': [], 'freshness': deepcopy(fresh)},
            'claude': {'total': 8_400_000, 'records': 4, 'costUSD': 4.2, 'costKind': 'reported',
                       'knownCostUSD': 4.2, 'estimatedRecords': 0, 'reportedRecords': 4, 'unpricedRecords': 0,
                       'perModel': [], 'freshness': deepcopy(fresh)}}}
        self.snapshot['periods'] = {'last30days': self.period}
        self.period['providers']['cursor'] = {'total': 0, 'records': 0, 'freshness': deepcopy(fresh)}

    def test_new_sources_are_registered(self):
        for source in ('usage-tokens-30d', 'usage-cost-30d', 'usage-limits'):
            self.assertIn(source, USAGE_SOURCES)

    def test_last30days_totals_and_rows_use_only_that_period(self):
        before = deepcopy(self.snapshot)
        tokens = self.show('usage-tokens-30d')
        self.assertEqual((tokens['value'], tokens['unit']), ('27.6', 'M tokens'))
        self.assertEqual(tokens['detail'], 'Last 30 days · cached as of 06 Oct 19:59 UTC\nCodex\t19.2M\tcached\nClaude\t8.4M\tcached')
        cost = self.show('usage-cost-30d')
        self.assertEqual((cost['value'], cost['unit']), ('17.00', 'USD'))
        self.assertEqual(cost['detail'], 'API estimate · Last 30 days · cached as of 06 Oct 19:59 UTC\nCodex\t12.80\tcached\nClaude\t4.20\tcached')
        self.assertEqual(before, self.snapshot)

    def test_absent_or_wrong_period_never_falls_back_to_daily(self):
        for periods in (None, {}, {'last30days': None}, {'last30days': {'scope': {'period': 'today'}}}):
            with self.subTest(periods=periods):
                self.snapshot['periods'] = periods
                for source in ('usage-tokens-30d', 'usage-cost-30d'):
                    result = self.show(source)
                    self.assertEqual(result['value'], '—')
                    self.assertIn('Last 30 days', result['detail'])
                    self.assertIn('Codex\t—\tUnavailable', result['detail'])
                    self.assertIn('Claude\t—\tUnavailable', result['detail'])

    def test_missing_provider_makes_known_total_explicitly_partial(self):
        del self.period['providers']['claude']
        tokens = self.show('usage-tokens-30d')
        self.assertEqual(tokens['value'], '19.2+')
        self.assertTrue(tokens['detail'].startswith('Partial · Claude unavailable · Last 30 days'))
        cost = self.show('usage-cost-30d')
        self.assertEqual(cost['value'], '12.80+')
        self.assertTrue(cost['detail'].startswith('Partial API estimate'))
        self.assertIn('Claude\t—\tUnavailable', cost['detail'])

    def test_all_missing_providers_are_unavailable(self):
        self.period['providers'] = {}
        for source in ('usage-tokens-30d', 'usage-cost-30d'):
            self.assertEqual(self.show(source)['value'], '—')
            self.assertIsNone(self.show(source, 'gauge')['value'])

    def test_partial_cost_has_plus_on_total_and_provider_row(self):
        provider = self.period['providers']['claude']
        provider.update(costUSD=None, costKind='unavailable', knownCostUSD=1.2, reportedRecords=1, unpricedRecords=3)
        result = self.show('usage-cost-30d')
        self.assertEqual(result['value'], '14.00+')
        self.assertIn('Partial API estimate', result['detail'])
        self.assertIn('Claude\t1.20+\tpartial · cached', result['detail'])

    def test_unpriced_records_override_inconsistent_complete_cost(self):
        self.period['providers']['claude'].update(unpricedRecords=1, knownCostUSD=1.2)
        self.assertEqual(self.show('usage-cost-30d')['value'], '14.00+')

    def test_no_priced_records_does_not_turn_known_zero_into_complete_cost(self):
        for provider in self.period['providers'].values():
            provider.update(costUSD=None, costKind='unavailable', knownCostUSD=0,
                            reportedRecords=0, estimatedRecords=0, unpricedRecords=provider['records'])
        result = self.show('usage-cost-30d')
        self.assertEqual(result['value'], '—')
        self.assertIn('Codex\t—\tUnavailable', result['detail'])

    def test_a_priced_free_record_can_supply_an_explicit_partial_zero(self):
        self.period['providers'] = {'codex': deepcopy(self.period['providers']['codex'])}
        self.period['providers']['codex'].update(costUSD=None, costKind='unavailable', knownCostUSD=0,
                                               estimatedRecords=1, unpricedRecords=9)
        self.assertEqual(self.show('usage-cost-30d')['value'], '0.00+')

    def test_valid_empty_period_cache_can_show_zero_without_inventing_missing_zero(self):
        for provider in self.period['providers'].values():
            provider.update(total=0, records=0, costUSD=None, costKind='unavailable', knownCostUSD=0,
                            estimatedRecords=0, reportedRecords=0, unpricedRecords=0)
        self.assertEqual(self.show('usage-tokens-30d')['value'], '0')
        self.assertEqual(self.show('usage-cost-30d')['value'], '0.00')
        for provider in self.period['providers'].values():
            provider['freshness']['tokens']['status'] = 'unavailable'
        self.assertEqual(self.show('usage-tokens-30d')['value'], '—')
        self.assertEqual(self.show('usage-cost-30d')['value'], '—')

    def test_cursor_rows_require_recorded_usage_and_unknown_costs_remain_visible(self):
        cursor = deepcopy(self.period['providers']['claude'])
        cursor.update(total=1500, records=1, costUSD=0.15, knownCostUSD=0.15, reportedRecords=1)
        self.period['providers']['cursor'] = cursor
        self.assertIn('Cursor\t1.5K\tcached', self.show('usage-tokens-30d')['detail'])
        self.assertIn('Cursor\t0.15\tcached', self.show('usage-cost-30d')['detail'])
        self.assertEqual(self.show('usage-cost-30d')['value'], '17.15')
        cursor.update(costUSD=None, costKind='unavailable', knownCostUSD=0, reportedRecords=0, unpricedRecords=1)
        result = self.show('usage-cost-30d')
        self.assertIn('Cursor\t—\tUnavailable', result['detail'])
        self.assertEqual(result['value'], '17.00+')
        cursor.update(total=0, records=0, unpricedRecords=0)
        self.assertNotIn('Cursor\t', self.show('usage-tokens-30d')['detail'])
        self.assertEqual(self.show('usage-cost-30d')['value'], '17.00')

    def test_last30days_token_units_and_gauge_values(self):
        self.period['providers']['claude']['total'] = 0
        self.period['providers']['codex']['total'] = 2400
        self.assertEqual((self.show('usage-tokens-30d')['value'], self.show('usage-tokens-30d')['unit']), ('2.4', 'K tokens'))
        self.assertEqual((self.show('usage-tokens-30d', 'gauge')['value'], self.show('usage-tokens-30d', 'gauge')['unit']), (2400, 'tokens'))
        self.period['providers']['codex']['total'] = 12
        self.assertEqual((self.show('usage-tokens-30d')['value'], self.show('usage-tokens-30d')['unit']), ('12', 'tokens'))

    def test_period_freshness_marks_stale_tokens_and_estimates(self):
        provider = self.period['providers']['codex']
        provider['freshness']['tokens']['stale'] = True
        result = self.show('usage-tokens-30d')
        self.assertIn('Last 30 days · stale', result['detail'])
        self.assertIn('Codex\t19.2M\tstale', result['detail'])
        provider['freshness']['tokens']['stale'] = False
        provider['freshness']['pricing']['stale'] = True
        self.assertIn('Codex\t12.80\tstale', self.show('usage-cost-30d')['detail'])
        provider['costKind'] = 'reported'
        self.assertIn('Codex\t12.80\tcached', self.show('usage-cost-30d')['detail'])

    def test_billions_missing_cursor_and_cache_observation_remain_explicit(self):
        self.period['providers']['codex']['total'] = 1_200_000_000
        del self.period['providers']['cursor']
        self.period['providers']['codex']['freshness']['tokens'].update(
            stale=True, observedAt='2026-10-05T01:02:00Z')
        result = self.show('usage-tokens-30d')
        self.assertEqual((result['value'], result['unit']), ('1.2+', 'B tokens'))
        self.assertIn('Cursor unavailable', result['detail'])
        self.assertIn('stale as of 05 Oct 01:02 UTC', result['detail'])
        self.assertIn('Codex\t1.2B\tstale', result['detail'])

    def test_unknown_metadata_shows_four_expected_windows_with_five_fields(self):
        result = self.show('usage-limits')
        rows = result['detail'].splitlines()[1:]
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(len(row.split('\t')) == 5 for row in rows))
        self.assertIn('Codex\tWeekly\t41\tresets 2h 05m\tcached', rows)
        self.assertIn('Codex\t5-hour\t-\treset unavailable\tUnavailable', rows)
        self.assertIn('Claude\tWeekly\t-\treset unavailable\tUnavailable', rows)
        self.assertTrue(result['detail'].startswith('Last observations'))

    def test_only_explicitly_unsupported_windows_are_hidden(self):
        providers = self.snapshot['providers']
        providers['codex']['quotaWindows'] = {'five_hour': 'unsupported', 'weekly': 'supported'}
        providers['claude']['quotaWindows'] = {'five_hour': 'unknown', 'weekly': 'unsupported'}
        rows = self.show('usage-limits')['detail'].splitlines()[1:]
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[0].startswith('Codex\tWeekly\t41'))
        self.assertTrue(rows[1].startswith('Claude\t5-hour\t-'))
        providers['codex']['quotaWindows']['weekly'] = 'unsupported'
        self.assertNotIn('Codex\t', self.show('usage-limits')['detail'])

    def test_monthly_and_model_weekly_cannot_replace_account_weekly(self):
        provider = self.snapshot['providers']['codex']
        provider['quotaWindows'] = {'five_hour': 'unknown', 'weekly': 'unknown'}
        weekly = deepcopy(provider['limits'][0])
        weekly.update(id='monthly', windowMinutes=43200, usedPercent=59, resetsAt='2026-10-08T23:00:00Z')
        session = deepcopy(weekly)
        session.update(id='weekly', windowMinutes=300, usedPercent=25)
        model = deepcopy(weekly)
        model.update(id='seven_day_sonnet', windowMinutes=10080, accountWeekly=False)
        provider['limits'] = [weekly, session, model]
        rows = self.show('usage-limits')['detail']
        self.assertIn('Codex\tWeekly\t-\treset unavailable\tUnavailable', rows)
        self.assertIn('Codex\t5-hour\t25\t', rows)

    def test_quota_duplicates_use_observation_instants_instead_of_id_or_string_order(self):
        provider = self.snapshot['providers']['codex']
        newer = deepcopy(provider['limits'][0])
        newer.update(id='secondary', observedAt='2026-10-06T19:59:30Z', usedPercent=59)
        older = deepcopy(newer)
        older.update(id='primary', observedAt='2026-10-06T21:59:00+02:00', usedPercent=98)
        provider['limits'] = [newer, older, deepcopy(newer)]
        rows = self.show('usage-limits')['detail'].splitlines()[1:]
        weekly = [row for row in rows if row.startswith('Codex\tWeekly')]
        self.assertEqual(len(weekly), 1)
        self.assertEqual(weekly[0].split('\t')[2], '59')

    def test_quota_observation_note_converts_offsets_to_utc(self):
        self.snapshot['providers']['codex']['limits'][0]['observedAt'] = '2026-10-06T21:59:00+02:00'
        self.assertTrue(self.show('usage-limits')['detail'].startswith('Last observations · 06 Oct 19:59 UTC'))

    def test_provider_limit_freshness_can_mark_an_observed_row_stale(self):
        self.snapshot['providers']['codex']['freshness']['limits'] = {'stale': True}
        self.assertIn('Codex\tWeekly\t41\tresets 2h 05m\tstale', self.show('usage-limits')['detail'])

    def test_elapsed_reset_retains_observed_percentage_and_marks_it_stale(self):
        self.snapshot['servedAt'] = '2026-10-06T23:00:00Z'
        result = self.show('usage-limits')
        self.assertIn('Codex\tWeekly\t41\treset time passed\tstale', result['detail'])
        self.assertNotIn('resets 0', result['detail'])

    def test_claude_notice_estimate_and_older_id_only_snapshots_are_supported(self):
        self.snapshot['providers']['claude']['limits'] = [
            {'id': 'five_hour', 'usedPercent': 100, 'observedAt': '2026-10-06T19:00:00Z',
             'resetsAt': '2026-10-06T21:20:00Z', 'resetKind': 'notice_relative_estimate', 'stale': True}]
        result = self.show('usage-limits')
        self.assertIn('Claude\t5-hour\t100\tresets 1h 20m · estimate\tstale', result['detail'])
        self.snapshot['servedAt'] = '2026-10-06T22:00:00Z'
        self.assertIn('Claude\t5-hour\t100\treset time passed · estimate\tstale', self.show('usage-limits')['detail'])

    def test_quota_rejects_invalid_percentages_without_clamping_them(self):
        limit = self.snapshot['providers']['codex']['limits'][0]
        for value in (None, -1, 101, float('nan'), float('inf'), True, '59'):
            with self.subTest(value=value):
                limit['usedPercent'] = value
                self.assertIn('Codex\tWeekly\t-\t', self.show('usage-limits')['detail'])
        for value in (0, 100, 59.5):
            with self.subTest(value=value):
                limit['usedPercent'] = value
                self.assertIn(f'Codex\tWeekly\t{value:g}\t', self.show('usage-limits')['detail'])

    def test_missing_clock_or_reset_remains_unknown(self):
        for served, reset in ((None, '2026-10-07T00:00:00Z'), ('2026-10-06T20:00:00Z', None)):
            with self.subTest(served=served, reset=reset):
                self.snapshot['servedAt'] = served
                self.snapshot['providers']['codex']['limits'][0]['resetsAt'] = reset
                self.assertIn('Codex\tWeekly\t41\treset unavailable\tcached', self.show('usage-limits')['detail'])

    def test_unknown_limits_or_auth_never_mean_unsupported(self):
        for provider in self.snapshot['providers'].values():
            provider.update(limits=[], errors=['no_auth'])
        self.assertEqual(len(self.show('usage-limits')['detail'].splitlines()), 5)
        self.assertEqual(len(self.show('usage-limits', snapshot={})['detail'].splitlines()), 5)

    def test_malformed_optional_metadata_is_safe_and_snapshots_are_not_mutated(self):
        for provider in self.snapshot['providers'].values():
            provider.update(quotaWindows=None, limits=None)
        self.period['providers'].update(claude=None, cursor=None)
        before = deepcopy(self.snapshot)
        for source in ('usage-tokens-30d', 'usage-cost-30d', 'usage-limits'):
            widget = deepcopy(self.widget)
            widget['settings']['source'] = source
            original = deepcopy(widget)
            self.assertIsNotNone(usage_content(widget, self.snapshot))
            self.assertEqual(widget, original)
        self.assertEqual(self.snapshot, before)


if __name__ == '__main__':
    unittest.main()
