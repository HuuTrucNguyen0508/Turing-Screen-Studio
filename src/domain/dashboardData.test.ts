import { describe, expect, it } from 'vitest';
import { dashboardRows, shortDashboardText } from './dashboardData';
import { createSampleLayout, validateLayout } from './layout';

describe('local dashboard data', () => {
  it('keeps unavailable activity distinct from an idle T3 server', () => {
    expect(dashboardRows('bad JSON').working).toBeNull();
    expect(dashboardRows(JSON.stringify({ working: 0, threads: [] })).working).toBe(0);
    expect(dashboardRows(JSON.stringify({ working: true })).working).toBeNull();
  });
  it('bounds and sanitizes rows without inventing game counts', () => {
    const data = dashboardRows(JSON.stringify({ working: 2, threads: Array(20).fill({ title: 'Task\nname', provider: 'Codex' }),
      games: [{ name: 'Genshin', current: 0, capacity: 200, status: 'not-configured' }, { name: 'WuWa', current: 300, capacity: 240, status: 'estimate' }] }));
    expect(data.threads).toHaveLength(5);
    expect(data.threads[0].title).toBe('Task name');
    expect(data.games.map(row => row.current)).toEqual([null, 300]);
    expect(dashboardRows(JSON.stringify({ working: 1, threads: [null, 42, { title: 'Valid' }], games: [false] })).threads).toHaveLength(1);
    expect(dashboardRows(JSON.stringify({ games: [false] })).games).toEqual([]);
    expect(shortDashboardText('😀😀😀', 20, 16)).toBe('😀…');
  });
  it('allows the sources only on metric cards without trends', () => {
    for (const source of ['t3-threads', 'game-resources']) {
      const doc = createSampleLayout();
      const card = { ...doc.widgets[0], type: 'metric', settings: { label: 'Local', value: '', unit: '', detail: '', source } };
      const parsed = validateLayout({ ...doc, widgets: [card] }).widgets[0];
      expect(parsed.type === 'metric' ? parsed.settings.source : undefined).toBe(source);
      expect(() => validateLayout({ ...doc, widgets: [{ ...card, settings: { ...card.settings, trend: true } }] })).toThrow('do not support a trend');
      expect(() => validateLayout({ ...doc, widgets: [{ ...card, type: 'gauge', settings: { label: 'Local', value: 0, min: 0, max: 100, detail: '', unit: '', source } }] })).toThrow('require a metric');
    }
  });
});
