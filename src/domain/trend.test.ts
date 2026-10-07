import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { CardContent } from '../WidgetContent';
import { createSampleLayout, parseLayout, serializeLayout, validateLayout } from './layout';
import { addWidget, duplicateWidget, updateWidgetSettings, widgetCatalog, widgetSources } from './widgets';
import { demoTrendHistory, TREND_CAPACITY, trendCaption, trendChart, trendHistory, trendRange, trendSources, trendUnit } from './trend';

const python = (script: string, value: unknown): unknown => JSON.parse(execFileSync('python3', ['-c', script], {
  input: JSON.stringify(value), env: { ...process.env, PYTHONPATH: 'runtime' }, encoding: 'utf8',
}));
const validatePython = (value: unknown) => python(`import json,sys
from turzx_studio.layout import validate_layout
try:
 print(json.dumps({'document':validate_layout(json.load(sys.stdin))}))
except ValueError as error:
 print(json.dumps({'error':str(error)}))`, value);
const empty = () => ({ ...createSampleLayout(), widgets: [] });

describe('optional metric trend settings', () => {
  it('preserves legacy bytes and retains explicit true and false in both validators', () => {
    const old = readFileSync('public/sample-layout.json', 'utf8');
    expect(serializeLayout(parseLayout(old))).toBe(old);
    expect(validatePython(parseLayout(old))).toEqual({ document: parseLayout(old) });
    for (const trend of [true, false]) {
      const doc = updateWidgetSettings(createSampleLayout(), 'cpu', { trend });
      expect(doc.widgets[0].settings).toHaveProperty('trend', trend);
      expect(parseLayout(serializeLayout(doc))).toEqual(doc);
      expect(validatePython(doc)).toEqual({ document: doc });
    }
    const legacy = parseLayout(old).widgets[0];
    expect(legacy.settings).not.toHaveProperty('trend');
  });

  it('rejects non-booleans and trend settings on other types with the same paths', () => {
    for (const trend of [null, 0, 1, 'true', {}, [], undefined]) {
      const doc = createSampleLayout();
      const invalid = { ...doc, widgets: [{ ...doc.widgets[0], settings: { ...doc.widgets[0].settings, trend } }] };
      expect(() => validateLayout(invalid)).toThrow('$.widgets[0].settings.trend: expected a boolean');
      if (trend !== undefined) expect(validatePython(invalid)).toEqual({ error: '$.widgets[0].settings.trend: expected a boolean' });
    }
    for (const id of ['gauge', 'clock', 'weather', 'text', 'mounted-storage']) {
      const doc = addWidget(empty(), id);
      const invalid = { ...doc, widgets: [{ ...doc.widgets[0], settings: { ...doc.widgets[0].settings, trend: true } }] };
      expect(() => validateLayout(invalid)).toThrow('$.widgets[0].settings.trend: unexpected field');
      expect(validatePython(invalid)).toEqual({ error: '$.widgets[0].settings.trend: unexpected field' });
    }
  });

  it('catalog additions keep their settings when saved, duplicated and reopened', () => {
    for (const source of trendSources) {
      const entry = widgetCatalog.find(({ id }) => id === `${source}-trend`)!;
      expect(entry.widget).toMatchObject({ type: 'metric', settings: { source, trend: true } });
      expect(widgetSources(entry.widget)).toEqual(['sample', ...trendSources]);
      const doc = duplicateWidget(addWidget(empty(), entry.id), entry.id);
      expect(parseLayout(serializeLayout(doc))).toEqual(doc);
      expect(validatePython(doc)).toEqual({ document: doc });
      expect(doc.widgets[1].settings).toEqual(doc.widgets[0].settings);
      expect(doc.widgets[1].settings).not.toBe(doc.widgets[0].settings);
    }
    const schema = JSON.parse(readFileSync('public/layout.schema.json', 'utf8'));
    for (const definition of schema.properties.widgets.items.oneOf) {
      const { properties, required } = definition.properties.settings;
      expect(required).not.toContain('trend');
      if (definition.properties.type.const === 'metric') expect(properties.trend).toEqual({ type: 'boolean' });
      else expect(properties).not.toHaveProperty('trend');
    }
  });
});

describe('trend history and geometry', () => {
  it('caps by slots, preserves gaps and rejects unknown or nonfinite readings', () => {
    expect(trendHistory(undefined)).toEqual([]);
    expect(trendHistory([true, '2', NaN, Infinity, null, 0])).toEqual([null, null, null, null, null, 0]);
    const history = Array.from({ length: 140 }, (_, index) => index === 30 ? null : index);
    const capped = trendHistory(history);
    expect(capped).toHaveLength(TREND_CAPACITY);
    expect(capped[0]).toBe(20);
    expect(capped[10]).toBeNull();
    expect(capped.at(-1)).toBe(139);
    expect(demoTrendHistory('unknown')).toEqual([]);
    expect(demoTrendHistory('cpu')).toEqual(demoTrendHistory('cpu'));
    expect(demoTrendHistory('cpu')).toHaveLength(120);
  });

  it('uses fixed percentage bounds, automatic KB/s and temperature bounds', () => {
    for (const source of ['cpu', 'gpu', 'memory', 'disk']) {
      expect(trendRange(source, [24, 30])).toEqual([0, 100]);
      expect(trendUnit(source)).toBe('%');
    }
    expect(trendRange('network-down', [null, 300, 900])).toEqual([0, 900]);
    expect(trendUnit('network-down')).toBe('KB/s');
    expect(trendRange('cpu-temperature', [-5, 40])).toEqual([-5, 40]);
    expect(trendUnit('cpu-temperature')).toBe('°C');
    expect(trendRange('network-up', [null, 0, 0])).toEqual([0, 1]);
    const extremes = trendChart('cpu-temperature', [-1e308, 1e308], 352, 304);
    expect(extremes.segments.flat().every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });

  it('does not bridge gaps or stretch a short observed history across all 120 readings', () => {
    const chart = trendChart('cpu', [10, 20, null, 30, 40], 352, 304);
    expect(chart.segments.map((points) => points.length)).toEqual([2, 2]);
    expect(chart.segments[0][0].x).toBeGreaterThan(chart.left + 280);
    expect(chart.segments[1].at(-1)?.x).toBe(chart.right);
    expect(chart.state).toBe('');
    expect(trendChart('cpu', [], 352, 304).state).toBe('No history yet');
    expect(trendChart('cpu', [null, null], 352, 304).state).toBe('No history yet');
    expect(trendChart('cpu', [10], 352, 304).state).toBe('Collecting history');
    expect(trendChart('cpu', [10, null, 20], 352, 304).state).toBe('Collecting history');
    const clamped = trendChart('cpu', [-100, 200], 352, 304);
    expect(clamped.segments[0].map(({ y }) => y)).toEqual([clamped.bottom, clamped.top]);
    expect(trendCaption(false)).toBe('Last 120 readings · Observed');
    expect(trendCaption(true)).toBe('Last 120 readings · Demo');
  });

  it('labels observation count without assuming a collector cadence or elapsed window', () => {
    // GPU throttling and missing polls mean 120 readings can span more than two minutes.
    for (const demo of [true, false]) {
      expect(trendCaption(demo)).toContain(String(TREND_CAPACITY));
      expect(trendCaption(demo)).not.toMatch(/minute|second|time/i);
    }
    const readings = [10, null, 30, null, 40];
    const chart = trendChart('cpu', readings, 352, 304);
    expect(chart.count).toBe(3);
    expect(chart.segments.map((points) => points[0].x)).toEqual([313, 318, 323]);
  });

  it('matches Python geometry, range, caps and demo samples for every source', () => {
    const cases = [...trendSources, 'sample', 'unknown'].flatMap((source) =>
      [[], [0], [null, 0, 40, null, 15, 90], Array.from({ length: 140 }, (_, index) => index % 13 === 0 ? null : index)]
        .map((history) => ({ source, history })));
    const actual = python(`import json,sys
from turzx_studio.trend import trend_chart,demo_trend_history
print(json.dumps([{'chart':trend_chart(case['source'],case['history'],352,304),'demo':demo_trend_history(case['source'])} for case in json.load(sys.stdin)]))`, cases);
    expect(actual).toEqual(cases.map(({ source, history }) => ({ chart: trendChart(source, history, 352, 304), demo: demoTrendHistory(source) })));
  });

  it('renders browser SVG demo history while preserving the legacy metric markup', () => {
    const trend = addWidget(empty(), 'cpu-trend').widgets[0];
    const markup = renderToStaticMarkup(createElement(CardContent, { widget: trend }));
    expect(markup).toContain('data-trend="true"');
    expect(markup).toContain('Last 120 readings · Demo');
    expect(markup).toContain('<polyline');
    expect(markup).toContain('0-100 %');
    const legacy = createSampleLayout().widgets[0];
    const oldMarkup = renderToStaticMarkup(createElement(CardContent, { widget: legacy }));
    expect(oldMarkup).toContain('class="sparkline"');
    expect(renderToStaticMarkup(createElement(CardContent, { widget: { ...legacy, settings: { ...legacy.settings, trend: false } } as typeof trend }))).toBe(oldMarkup);
  });
});
