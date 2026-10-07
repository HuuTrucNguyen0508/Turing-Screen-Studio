import { describe, expect, it } from 'vitest';
import { usageSummaryRows } from './usageSummary';

describe('usage summary display rows', () => {
  it('keeps provider ordering, partial totals and freshness labels', () => {
    const rows = usageSummaryRows('Partial API estimate, last 30 days\nCodex\t105.60+\tstale estimate\nClaude\t—\tunavailable\nCursor\t4.20\treported');
    expect(rows.providers).toEqual([
      { provider: 'Codex', value: '105.60+', state: 'stale estimate' },
      { provider: 'Claude', value: '—', state: 'unavailable' },
      { provider: 'Cursor', value: '4.20', state: 'reported' },
    ]);
    expect(rows.note).toContain('Partial');
  });
  it('shows remaining percentages including untouched, partial and exhausted quotas', () => {
    const rows = usageSummaryRows('Cached quotas\nCodex\tWeekly\t0\tresets 6d\tcached\nClaude\t5-hour\t41\tresets 2h\tcached\nClaude\tWeekly\t100\tresets 4d\tcached\nClaude\t5-hour\t100\treset time passed\tstale');
    expect(rows.quotas.map(row => row.remainingPercent)).toEqual([100, 59, 0, null]);
  });
  it('renders unknown quota values without converting them to zero', () => {
    const rows = usageSummaryRows('Cached quotas\nCodex\tWeekly\t0\tresets 6d\tcached\nClaude\tWeekly\t-\treset unavailable\tunavailable\nClaude\t5-hour\t101\treset unavailable\tunavailable');
    expect(rows.quotas.map(row => row.remainingPercent)).toEqual([100, null, null]);
    expect(rows.quotas[1].state).toBe('unavailable');
    expect(rows.quotas.some(row => row.provider === 'Codex' && row.window === '5-hour')).toBe(false);
  });
});
