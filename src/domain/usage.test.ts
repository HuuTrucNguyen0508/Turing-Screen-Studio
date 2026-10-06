import { describe, expect, it } from 'vitest';
import { createSampleLayout, metricSources, validateLayout, serializeLayout, parseLayout } from './layout';
import { dashboardHeading, isUsageSource, usageSources } from './usage';
import { widgetCatalog } from './widgets';

describe('usage sources and designed layouts', () => {
  it('registers every usage source without changing the classic sample', () => {
    expect(dashboardHeading(createSampleLayout())).toBe('System overview');
    for (const source of usageSources) expect(metricSources).toContain(source);
    expect(isUsageSource('cpu')).toBe(false);
    expect(isUsageSource(undefined)).toBe(false);
  });
  it('preserves source and sample settings through export and reopen', () => {
    for (const entry of widgetCatalog.filter(({ widget }) => widget.type !== 'text' && isUsageSource(widget.settings.source))) {
      const document = validateLayout({ ...createSampleLayout(), widgets: [entry.widget] });
      expect(parseLayout(serializeLayout(document))).toEqual(document);
      expect(dashboardHeading(document)).toBe(entry.widget.type !== 'text' && entry.widget.settings.source === 'storage' ? 'Storage overview' : 'AI usage');
    }
  });
});
