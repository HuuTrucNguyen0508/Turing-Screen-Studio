import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createSampleLayout, parseLayout, serializeLayout, validateLayout } from './layout';
import type { CalendarWidget, GraphWidget, LayoutDocument, ListRow, ListWidget, Widget } from './layout';
import { listFraction, listLayout, listSampleRow } from './list';
import { demoGraphHistory, graphChart, graphRange } from './graph';
import { calendarGeometry, calendarMonth } from './calendar';
import { demoTrendHistory, formatReading, trendSources } from './trend';

const rows = [
  { source: 'cpu', label: 'CPU', value: '24', unit: '%' },
  { source: 'cpu-temperature', label: 'CPU temp', value: '42', unit: '°C' },
  { source: 'network-down', label: 'Download', value: '640', unit: 'KB/s' },
] as const;
const widgets = (): [ListWidget, GraphWidget, CalendarWidget] => [
  { id: 'list', type: 'list', x: 64, y: 64, width: 352, height: 304, settings: { label: 'System', rows: rows.map((row) => ({ ...row })), bars: true } },
  { id: 'graph', type: 'graph', x: 440, y: 64, width: 564, height: 304, settings: { label: 'Network', style: 'area', sources: ['network-down', 'network-up'] } },
  { id: 'calendar', type: 'calendar', x: 64, y: 392, width: 352, height: 328, settings: { label: '', source: 'clock', weekStart: 'sunday' } },
];
const doc = (): LayoutDocument => ({ ...createSampleLayout(), widgets: widgets() });

function python(script: string, input: unknown): unknown {
  return JSON.parse(execFileSync('python3', ['-c', script], {
    input: JSON.stringify(input), env: { ...process.env, PYTHONPATH: 'runtime' }, encoding: 'utf8',
  }));
}
const pythonValidate = (value: unknown) => python(`import json,sys\nfrom turzx_studio.layout import validate_layout\ntry:\n print(json.dumps({'valid':True,'document':validate_layout(json.load(sys.stdin))},ensure_ascii=False))\nexcept ValueError as error:\n print(json.dumps({'valid':False,'error':str(error)}))`, value) as { valid: boolean; document?: unknown; error?: string };

describe('list, graph and calendar contract', () => {
  it('round trips each type through both validators', () => {
    const document = validateLayout(doc());
    expect(document.widgets).toEqual(widgets());
    expect(parseLayout(serializeLayout(document))).toEqual(document);
    expect(pythonValidate(document)).toEqual({ valid: true, document });
  });

  it('reports the same failing field in both validators', () => {
    const cases: [number, Record<string, unknown>, string][] = [
      [0, { rows: [] }, 'rows'], [0, { rows: Array.from({ length: 7 }, () => ({ ...rows[0] })) }, 'rows'],
      [0, { rows: [rows[0], rows[0]] }, 'rows'], [0, { rows: [{ ...rows[0], source: 'sample' }] }, 'rows[0].source'],
      [0, { rows: [{ ...rows[0], extra: 1 }] }, 'rows[0].extra'], [0, { rows: [{ source: 'cpu', label: 'CPU', value: '1' }] }, 'rows[0].unit'],
      [0, { rows: [{ ...rows[0], label: 'x'.repeat(33) }] }, 'rows[0].label'], [0, { rows: [{ ...rows[0], value: '1'.repeat(17) }] }, 'rows[0].value'],
      [0, { rows: [{ ...rows[0], unit: 'u'.repeat(9) }] }, 'rows[0].unit'], [0, { rows: 'cpu' }, 'rows'],
      [0, { bars: 'yes' }, 'bars'], [0, { label: 'x'.repeat(65) }, 'label'], [0, { source: 'cpu' }, 'source'],
      [1, { sources: [] }, 'sources'], [1, { sources: ['cpu', 'gpu', 'disk'] }, 'sources'],
      [1, { sources: ['cpu', 'cpu'] }, 'sources'], [1, { sources: ['cpu', 'weather'] }, 'sources[1]'],
      [1, { style: 'bars' }, 'style'], [1, { source: 'cpu' }, 'source'],
      [2, { source: 'cpu' }, 'source'], [2, { weekStart: 'saturday' }, 'weekStart'], [2, { label: 7 }, 'label'],
    ];
    for (const [index, patch, field] of cases) {
      const invalid = doc();
      invalid.widgets = [{ ...invalid.widgets[index], settings: { ...invalid.widgets[index].settings, ...patch } } as Widget];
      expect(() => validateLayout(invalid), field).toThrow(`$.widgets[0].settings.${field}`);
      const result = pythonValidate(invalid);
      expect(result.valid, field).toBe(false);
      expect(result.error).toContain(`$.widgets[0].settings.${field}:`);
    }
  });

  it('rejects controls in every single-line field identically', () => {
    for (const control of Array.from({ length: 33 }, (_, index) => String.fromCharCode(index === 32 ? 127 : index))) {
      for (const index of [0, 1, 2]) {
        const document = doc();
        const widget = widgets()[index];
        widget.settings.label = `Bad${control}`;
        document.widgets = [widget];
        expect(() => validateLayout(document)).toThrow('must not contain control characters');
        expect(pythonValidate(document)).toEqual({ valid: false, error: '$.widgets[0].settings.label: must not contain control characters' });
      }
      for (const field of ['label', 'value', 'unit']) {
        const document = doc();
        document.widgets = [{ ...widgets()[0], type: 'list', settings: { label: 'System', bars: true, rows: [{ ...rows[0], [field]: `24${control}` }] } }];
        expect(() => validateLayout(document)).toThrow(`$.widgets[0].settings.rows[0].${field}: must not contain control characters`);
        expect(pythonValidate(document)).toEqual({ valid: false, error: `$.widgets[0].settings.rows[0].${field}: must not contain control characters` });
      }
    }
  }, 15000);

  it('counts label limits in code points in both languages', () => {
    const labelled = (label: string) => ({ ...doc(), widgets: [{ ...widgets()[2], settings: { label, source: 'sample', weekStart: 'monday' } }] });
    expect(validateLayout(labelled('😀'.repeat(64))).widgets[0].settings).toMatchObject({ label: '😀'.repeat(64) });
    expect(pythonValidate(labelled('😀'.repeat(64)))).toMatchObject({ valid: true });
    const document = labelled('😀'.repeat(65));
    expect(() => validateLayout(document)).toThrow('must be at most 64 characters');
    expect(pythonValidate(document)).toMatchObject({ valid: false, error: expect.stringContaining('must be at most 64 characters') });
  });
});

describe('shared geometry with the PIL renderer', () => {
  it('formats readings half up in both languages', () => {
    const values = [24.5, 0.5, 1023.4, 1024, 1536.25, 42, null];
    const expected = [
      { value: '25', unit: '%' }, { value: '1', unit: 'KB/s' }, { value: '1023', unit: 'KB/s' }, { value: '1.0', unit: 'MB/s' },
      { value: '1.5', unit: 'MB/s' }, { value: '42', unit: '°C' }, { value: '—', unit: '°C' },
    ];
    const sources = ['cpu', 'network-down', 'network-down', 'network-up', 'network-up', 'gpu-temperature', 'cpu-temperature'];
    expect(values.map((value, index) => formatReading(sources[index], value))).toEqual(expected);
    expect(python(`import json,sys\nfrom turzx_studio.trend import format_reading\nd=json.load(sys.stdin)\nprint(json.dumps([format_reading(s,v) for s,v in zip(d['sources'],d['values'])],ensure_ascii=False))`, { sources, values })).toEqual(expected);
  });

  it('gives bars to percentages and temperatures only', () => {
    expect(listFraction('cpu', '24')).toBe(.24);
    expect(listFraction('gpu-temperature', '120')).toBe(1);
    expect(listFraction('memory', '—')).toBe(0);
    expect(listFraction('network-up', '90')).toBeNull();
    expect(listSampleRow('network-down')).toEqual({ source: 'network-down', label: 'Download', value: '820', unit: 'KB/s' });
  });

  it('matches list rows, shortening and capacity', () => {
    const cases = [[352, 304, 'System', true], [270, 224, '', false], [352, 120, 'Tiny', true], [564, 488, 'A long label that keeps going past the edge', true], [1, 1, '', true]] as const;
    const longRows: ListRow[] = [...rows, { source: 'gpu', label: 'A graphics card with a long name', value: '100', unit: '%' }, { source: 'disk', label: '', value: 'n/a', unit: '' }];
    const expected = cases.map(([width, height, label, bars]) => listLayout(width, height, label, longRows, bars));
    expect(python(`import json,sys\nfrom turzx_studio.list_display import list_layout\nd=json.load(sys.stdin)\nprint(json.dumps([list_layout(w,h,l,d['rows'],b) for w,h,l,b in d['cases']],ensure_ascii=False))`, { cases, rows: longRows })).toEqual(expected);
    expect(expected[0].rows.map(({ label, baseline, barY, fraction }) => ({ label, baseline, barY, fraction }))).toEqual([
      { label: 'CPU', baseline: 78, barY: 88, fraction: .24 }, { label: 'CPU temp', baseline: 122, barY: 132, fraction: .42 },
      { label: 'Download', baseline: 166, barY: null, fraction: null }, { label: 'A graphics card with a long name', baseline: 210, barY: 220, fraction: 1 },
      { label: 'Disk', baseline: 254, barY: 264, fraction: 0 },
    ]);
    expect(listLayout(270, 224, cases[3][2], rows, true).kicker).toBe('A long label that keeps g…');
    expect(listLayout(270, 224, '', [{ ...longRows[3], value: '100.0' }], true).rows[0].label).toBe('A graphic…');
    expect(expected[2].rows).toHaveLength(1);
    expect(expected[4].rows).toHaveLength(0);
  });

  it('matches graph series, shared axes and legends', () => {
    const cases: [string, string[], unknown[], number, number][] = [
      ['Network', ['network-down', 'network-up'], [demoTrendHistory('network-down'), demoTrendHistory('network-up')], 564, 304],
      ['CPU load', ['cpu'], [demoTrendHistory('cpu')], 352, 304],
      ['Mixed', ['cpu', 'cpu-temperature'], [[10, null, 30, 40], [50, 55, null]], 352, 304],
      ['', ['gpu'], [[]], 160, 200],
      ['Single', ['disk'], [[null, 7]], 120, 100],
    ];
    const expected = cases.map(([label, sources, inputs, width, height]) => graphChart(label, sources as never, inputs, width, height));
    expect(python(`import json,sys\nfrom turzx_studio.graph_display import graph_chart\nprint(json.dumps([graph_chart(*case) for case in json.load(sys.stdin)],ensure_ascii=False))`, cases)).toEqual(expected);
    expect(expected[0].range).toBe('0-865 KB/s');
    expect(expected[0].series.map(({ reading, legend }) => [reading.value, legend.x])).toEqual([['820', 29], ['116', 282]]);
    expect(expected[2].range).toBe('0-100 % · 48-57 °C');
    expect(expected[2].series.map(({ last }) => last)).toEqual([{ x: 323, y: 211 }, null]);
    expect(expected[3].state).toBe('No history yet');
    expect(expected[4].state).toBe('Collecting history');
  });

  it('uses only the latest observation in graph legends and keeps earlier points', () => {
    const chart = graphChart('Mixed', ['cpu', 'network-down'], [[12, 25, null], [100, 500, null]], 352, 304);
    expect(chart.series.map(({ reading }) => reading)).toEqual([{ value: '—', unit: '%' }, { value: '—', unit: 'KB/s' }]);
    expect(chart.series.every(({ last, lines }) => last === null && lines.length === 1)).toBe(true);
    expect(chart.rangeY - Math.max(...chart.series.map(({ legend }) => legend.valueY))).toBeGreaterThanOrEqual(24);
    expect(chart.top - chart.rangeY).toBeGreaterThanOrEqual(14);
    expect(python(`import json,sys
from turzx_studio.graph_display import graph_chart
print(json.dumps(graph_chart(*json.load(sys.stdin)),ensure_ascii=False))`, ['Mixed', ['cpu', 'network-down'], [[12, 25, null], [100, 500, null]], 352, 304])).toEqual(chart);
  });

  it('uses smooth graph-only demo histories and padded temperature axes in both languages', () => {
    const histories = trendSources.map(demoGraphHistory);
    expect(python(`import json,sys
from turzx_studio.graph_display import demo_graph_history
print(json.dumps([demo_graph_history(source) for source in json.load(sys.stdin)]))`, trendSources)).toEqual(histories);
    expect(histories.every((history) => history.length === 120)).toBe(true);
    for (const index of [0, 1]) {
      expect(Math.max(...histories[index].slice(1).map((value, slot) => Math.abs(value - histories[index][slot])))).toBeLessThan(1);
    }
    expect(histories[0]).not.toEqual(demoTrendHistory('cpu'));
    const cases = [['cpu-temperature', [42, 46, null]], ['gpu-temperature', [55, 55]], ['cpu-temperature', []], ['cpu', [24, 28]]] as const;
    const ranges = cases.map(([source, history]) => graphRange(source, history));
    expect(ranges).toEqual([[40, 48], [53, 57], [0, 100], [0, 100]]);
    expect(python(`import json,sys
from turzx_studio.graph_display import graph_range
print(json.dumps([graph_range(*case) for case in json.load(sys.stdin)]))`, cases)).toEqual(ranges);
  });

  it('matches month grids and calendar geometry', () => {
    expect(calendarMonth('2026-10-06', 'monday')).toMatchObject({
      title: 'October', year: '2026', today: 6,
      weeks: [[null, null, null, 1, 2, 3, 4], [5, 6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16, 17, 18], [19, 20, 21, 22, 23, 24, 25], [26, 27, 28, 29, 30, 31, null]],
    });
    expect(calendarMonth('2026-10-06', 'sunday')?.weekdays.map(({ name }) => name)).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
    const dates = ['2026-10-06', '2026-02-28', '2024-02-29', '2023-02-29', '2026-13-01', '0026-01-01', 'today', '2031-03-31'];
    const months = dates.flatMap((date) => (['monday', 'sunday'] as const).map((start) => calendarMonth(date, start)));
    const sizes = [[352, 328, 'Calendar', 5], [564, 488, '', 6], [270, 224, 'Week', 6], [40, 40, '', 6]] as const;
    expect(python(`import json,sys\nfrom turzx_studio.calendar_display import calendar_month,calendar_geometry\nd=json.load(sys.stdin)\nprint(json.dumps({'months':[calendar_month(date,start) for date in d['dates'] for start in ('monday','sunday')],'geometry':[calendar_geometry(*size) for size in d['sizes']]}))`, { dates, sizes }))
      .toEqual({ months, geometry: sizes.map(([width, height, label, weeks]) => calendarGeometry(width, height, label, weeks)) });
    expect(months.slice(6, 14).every((month) => month === null)).toBe(true);
    expect(calendarGeometry(352, 328, 'Calendar', 5)).toMatchObject({ titleY: 75, gridTop: 107, cellWidth: 42, cellHeight: 41, daySize: 19 });
  });
});
