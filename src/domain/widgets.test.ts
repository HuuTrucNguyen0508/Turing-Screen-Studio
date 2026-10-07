import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import sharedCatalog from '../../public/widget-catalog.json';
import { createSampleLayout, gaugeStyles, metricSources, parseLayout, serializeLayout, validateLayout } from './layout';
import type { LayoutDocument } from './layout';
import { addWidget, addWidgetTemplate, duplicateWidget, formatClockTime, formatGaugeNumber, gaugeFraction, gaugeGeometry, parseLayoutPresets, parseWidgetCatalog, removeWidget, updateWidgetSettings, widgetCatalog, widgetGroups, widgetSources } from './widgets';

const empty = (): LayoutDocument => ({ ...createSampleLayout(), widgets: [] });

function pythonValidate(value: unknown): { valid: boolean; document?: unknown; error?: string } {
  const script = `import json,sys\nfrom turzx_studio.layout import validate_layout\ntry:\n doc=validate_layout(json.load(sys.stdin))\n print(json.dumps({'valid':True,'document':doc},ensure_ascii=False))\nexcept ValueError as error:\n print(json.dumps({'valid':False,'error':str(error)}))`;
  return JSON.parse(execFileSync('python3', ['-c', script], {
    input: JSON.stringify(value), env: { ...process.env, PYTHONPATH: 'runtime' }, encoding: 'utf8',
  })) as ReturnType<typeof pythonValidate>;
}

describe('widget editing', () => {
  it('copies centered catalog designs and custom templates without linking placed cards', () => {
    const centered = widgetCatalog.find(({ id }) => id === 'clock-centered')!;
    const added = addWidget(empty(), centered.id);
    expect(added.widgets[0].design).toEqual(centered.widget.design);
    expect(added.widgets[0].design?.elements?.time).not.toBe(centered.widget.design?.elements?.time);
    const { id, x, y, ...template } = added.widgets[0];
    void id; void x; void y;
    const custom = addWidgetTemplate(added, template, 'clock-centered');
    expect(custom.widgets[1].id).toBe('clock-centered-2');
    expect(custom.widgets[1].design).toEqual(added.widgets[0].design);
    expect(custom.widgets[1].design).not.toBe(added.widgets[0].design);
    const copied = duplicateWidget(custom, custom.widgets[1].id);
    expect(copied.widgets[2].design).toEqual(custom.widgets[1].design);
    expect(copied.widgets[2].design?.elements).not.toBe(custom.widgets[1].design?.elements);
    if (custom.widgets[1].design?.elements?.time) custom.widgets[1].design.elements.time.align = 'end';
    expect(added.widgets[0].design?.elements?.time?.align).toBe('center');
    expect(centered.widget.design?.elements?.time?.align).toBe('center');
  });
  it('keeps UI additions consistent with the public AI widget catalog', () => {
    const catalog = JSON.parse(readFileSync('public/widget-catalog.json', 'utf8'));
    expect(widgetGroups).toEqual(catalog.groups);
    expect(widgetCatalog.map(({ widget, ...metadata }) => ({ ...metadata, type: widget.type, width: widget.width, height: widget.height, settings: widget.settings, ...(widget.design ? { design: widget.design } : {}) }))).toEqual(catalog.widgets);
    expect(widgetCatalog.every(({ id, widget }) => widget.id === id && widget.x === 0 && widget.y === 0)).toBe(true);
  });
  it('keeps all 107 choices, nine unique groups and the original IDs', () => {
    expect(widgetCatalog).toHaveLength(107);
    expect(new Set(widgetCatalog.map(({ id }) => id)).size).toBe(widgetCatalog.length);
    expect(widgetGroups.map(({ id }) => id)).toEqual(['system', 'network', 'temperature', 'gauge', 'clock', 'weather', 'text', 'ai-usage', 'storage']);
    expect(new Set(widgetGroups.map(({ id }) => id)).size).toBe(widgetGroups.length);
    expect(widgetCatalog.slice(0, 12).map(({ id }) => id)).toEqual([
      'cpu', 'gpu', 'memory', 'disk', 'network-down', 'network-up', 'cpu-temperature', 'gpu-temperature', 'weather', 'clock', 'text', 'gauge',
    ]);
    expect(sharedCatalog.metricSources).toEqual(metricSources);
    for (const { widget, group } of widgetCatalog) {
      expect(widgetGroups.some(({ id }) => id === group)).toBe(true);
      if (widget.type !== 'text') expect(widgetSources(widget)).toContain(widget.settings.source);
      if (widget.type === 'gauge') {
        expect(widget.settings.min).toBeLessThan(widget.settings.max);
        expect(widget.settings.value).toBeGreaterThanOrEqual(widget.settings.min);
        expect(widget.settings.value).toBeLessThanOrEqual(widget.settings.max);
        expect([widget.settings.min, widget.settings.max, widget.settings.value].every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('detaches catalog metadata and settings from JSON, sibling variants and additions', () => {
    const parsed = parseWidgetCatalog(sharedCatalog);
    expect(parsed.groups[0]).not.toBe(sharedCatalog.groups[0]);
    for (const [index, entry] of parsed.entries.entries()) expect(entry.widget.settings).not.toBe(sharedCatalog.widgets[index].settings);
    const before = JSON.stringify(sharedCatalog);
    if (parsed.entries[0].widget.type === 'metric') parsed.entries[0].widget.settings.label = 'Changed local copy';
    parsed.groups[0].name = 'Changed group';
    expect(JSON.stringify(sharedCatalog)).toBe(before);
    const first = addWidget(empty(), 'cpu');
    const next = addWidget(first, 'cpu-wide');
    if (next.widgets[0].type === 'metric') next.widgets[0].settings.label = 'Changed added card';
    expect(first.widgets[0].settings).toMatchObject({ label: 'CPU load' });
    expect(first.widgets[0].type).toBe('metric');
    expect(next.widgets[1].settings).toMatchObject({ label: 'CPU load' });
    expect(widgetCatalog[0].widget.settings).toMatchObject({ label: 'CPU load' });
  });

  it('rejects malformed shared catalog metadata and invalid geometry or sources', () => {
    expect(() => parseWidgetCatalog({})).toThrow('widget catalog');
    expect(() => parseWidgetCatalog({ ...sharedCatalog, groups: [...sharedCatalog.groups, sharedCatalog.groups[0]] })).toThrow('Duplicate widget group');
    for (const patch of [{ group: 'missing' }, { family: '' }, { width: 1.5 }, { settings: { ...sharedCatalog.widgets[0].settings, source: 'weather' } }]) {
      expect(() => parseWidgetCatalog({ ...sharedCatalog, widgets: [{ ...sharedCatalog.widgets[0], ...patch }] })).toThrow();
    }
    expect(() => parseWidgetCatalog({ ...sharedCatalog, widgets: [sharedCatalog.widgets[0], sharedCatalog.widgets[0]] })).toThrow('duplicate widget ID');
  });

  it('adds all catalog entries with bounded integer geometry and stable unique IDs', () => {
    let doc = empty();
    for (let repeat = 0; repeat < 2; repeat++) for (const preset of widgetCatalog) doc = addWidget(doc, preset.id);
    expect(new Set(doc.widgets.map((widget) => widget.id)).size).toBe(widgetCatalog.length * 2);
    expect(doc.widgets.map((widget) => widget.id).slice(0, widgetCatalog.length)).toEqual(widgetCatalog.map((entry) => entry.id));
    expect(validateLayout(doc)).toEqual(doc);
    expect(parseLayout(serializeLayout(doc))).toEqual(doc);
    expect(pythonValidate(doc)).toEqual({ valid: true, document: doc });
  });

  it('finds free placement, bounds tiny canvases, and keeps duplicated settings detached', () => {
    const first = addWidget(empty(), 'clock');
    const next = duplicateWidget(first, 'clock');
    const [a, b] = next.widgets;
    expect(b.x >= a.x + a.width || b.y >= a.y + a.height || b.x + b.width <= a.x || b.y + b.height <= a.y).toBe(true);
    expect(b.settings).toEqual(a.settings);
    expect(b.settings).not.toBe(a.settings);
    expect(first.widgets).toHaveLength(1);
    const tiny = addWidget({ ...empty(), canvas: { width: 1, height: 1 } }, 'gauge');
    expect(tiny.widgets[0]).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
    expect(validateLayout(duplicateWidget(tiny, 'gauge'))).toBeTruthy();
  });

  it('edits settings without moving cards and supports deleting every card', () => {
    const before = addWidget(empty(), 'text');
    const after = updateWidgetSettings(before, 'text', { text: 'First line\nSecond line', label: 'Desk note' });
    expect(after.widgets[0]).toEqual({ ...before.widgets[0], settings: { label: 'Desk note', text: 'First line\nSecond line' } });
    expect(before.widgets[0].settings).toEqual({ label: 'Notes', text: 'One task at a time.' });
    expect(validateLayout(removeWidget(after, 'text')).widgets).toEqual([]);
    expect(() => updateWidgetSettings(before, 'text', { source: 'cpu' })).toThrow('source');
  });
});

describe('expanded v1 contract shared with Python', () => {
  it('preserves each gauge style and omission across both validators and round trips', () => {
    const doc = addWidget(empty(), 'cpu-gauge');
    expect(doc.widgets[0].settings).not.toHaveProperty('style');
    for (const style of gaugeStyles) {
      const changed = updateWidgetSettings(doc, 'cpu-gauge', { style });
      expect(changed.widgets[0]).toEqual({ ...doc.widgets[0], settings: { ...doc.widgets[0].settings, style } });
      expect(parseLayout(serializeLayout(changed))).toEqual(changed);
      expect(pythonValidate(changed)).toEqual({ valid: true, document: changed });
    }
  });
  it('rejects unsupported styles and style on other widget types in both languages', () => {
    for (const [id, style] of [['gauge', null], ['gauge', true], ['gauge', 'pie'], ['gauge', 'Ring'], ['gauge', 0], ['cpu', 'ring'], ['weather', 'ring'], ['clock', 'ring'], ['text', 'ring']] as const) {
      const doc = addWidget(empty(), id);
      const invalid = { ...doc, widgets: [{ ...doc.widgets[0], settings: { ...doc.widgets[0].settings, style } }] };
      expect(() => validateLayout(invalid)).toThrow('settings.style');
      expect(pythonValidate(invalid)).toMatchObject({ valid: false, error: expect.stringContaining('settings.style') });
    }
  });

  it('rejects malformed settings and reports the same field in both validators', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['gauge', { value: '24' }, 'value'], ['gauge', { min: 100 }, 'max'],
      ['gauge', { max: 0 }, 'max'], ['gauge', { value: 101 }, 'value'],
      ['gauge', { value: -1 }, 'value'], ['gauge', { min: true }, 'min'],
      ['gauge', { source: 'weather' }, 'source'], ['clock', { showDate: 1 }, 'showDate'],
      ['clock', { format: 'seconds' }, 'format'], ['clock', { source: 'cpu' }, 'source'],
      ['text', { text: false }, 'text'], ['text', { source: 'sample' }, 'source'],
    ];
    for (const [kind, patch, field] of cases) {
      const doc = addWidget(empty(), kind);
      const invalid = { ...doc, widgets: [{ ...doc.widgets[0], settings: { ...doc.widgets[0].settings, ...patch } }] };
      expect(() => validateLayout(invalid)).toThrow(`$.widgets[0].settings.${field}`);
      const result = pythonValidate(invalid);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(`$.widgets[0].settings.${field}`);
    }
  });

  it('enforces bounds and compatible sources across every shared catalog variant in both languages', () => {
    for (const { id, widget } of widgetCatalog) {
      const patches: [Record<string, unknown>, string][] = [];
      if (widget.type === 'gauge') {
        patches.push([{ value: widget.settings.max + 1 }, 'value'], [{ min: widget.settings.max }, 'max']);
      }
      if (widget.type === 'metric' || widget.type === 'gauge') patches.push([{ source: 'weather' }, 'source']);
      else if (widget.type === 'clock' || widget.type === 'weather' || widget.type === 'storage') patches.push([{ source: 'cpu' }, 'source']);
      else patches.push([{ source: 'sample' }, 'source']);
      for (const [patch, field] of patches) {
        const doc = addWidget(empty(), id);
        const invalid = { ...doc, widgets: [{ ...doc.widgets[0], settings: { ...doc.widgets[0].settings, ...patch } }] };
        expect(() => validateLayout(invalid)).toThrow(`$.widgets[0].settings.${field}`);
        const result = pythonValidate(invalid);
        expect(result.valid).toBe(false);
        expect(result.error).toContain(`$.widgets[0].settings.${field}`);
      }
    }
  }, 15_000);

  it('rejects nonfinite gauges and preserves absent optional fields and decimal values', () => {
    let doc = addWidget(empty(), 'gauge');
    for (const value of [NaN, Infinity, -Infinity]) expect(() => updateWidgetSettings(doc, 'gauge', { value })).toThrow('finite');
    doc = updateWidgetSettings(doc, 'gauge', { min: -1.5, max: 8.75, value: 0.125 });
    if (doc.widgets[0].type === 'gauge') delete doc.widgets[0].settings.source;
    expect(parseLayout(serializeLayout(doc))).toEqual(doc);
    expect(pythonValidate(doc)).toEqual({ valid: true, document: doc });
    const old = createSampleLayout();
    expect(pythonValidate(old)).toEqual({ valid: true, document: old });
  });
});

describe('clock, gauge, and layout presets', () => {
  it('matches PIL gauge geometry and decimal rounding', () => {
    const dimensions = [[270, 304], [200, 240], [1, 1], [352, 224], [400, 488]];
    const numbers = [0, .25, -.25, .125, 24, 39.95, -0.05, 1e14];
    const script = `import json,sys\nfrom turzx_studio.renderer import gauge_geometry,gauge_number\nd=json.load(sys.stdin)\nprint(json.dumps({'geometry':[gauge_geometry(*size) for size in d['dimensions']],'numbers':[gauge_number(value) for value in d['numbers']]}))`;
    const result = JSON.parse(execFileSync('python3', ['-c', script], { input: JSON.stringify({ dimensions, numbers }), encoding: 'utf8', env: { ...process.env, PYTHONPATH: 'runtime' } }));
    expect(result).toEqual({ geometry: dimensions.map(([w, h]) => gaugeGeometry(w, h)), numbers: numbers.map(formatGaugeNumber) });
    expect(gaugeGeometry(270, 304)).toEqual({ radius: 101, cx: 135, cy: 164, size: 48 });
  });
  it('formats clocks without local time or seconds', () => {
    expect(formatClockTime('00:24:59', '12h')).toBe('12:24 AM');
    expect(formatClockTime('13:04', '12h')).toBe('1:04 PM');
    expect(formatClockTime('1:04 PM', '24h')).toBe('13:04');
    expect(formatClockTime('12:04 AM', '24h')).toBe('00:04');
    expect(formatClockTime('Unavailable', '24h')).toBe('Unavailable');
  });
  it('clamps gauge progress and avoids overflow with extreme finite bounds', () => {
    expect(gaugeFraction(25, 0, 100)).toBe(0.25);
    expect(gaugeFraction(-20, 0, 100)).toBe(0);
    expect(gaugeFraction(200, 0, 100)).toBe(1);
    expect(gaugeFraction(0, -1e308, 1e308)).toBe(0.5);
  });
  it('validates preset documents and catalog IDs, including empty layouts', () => {
    const preset = { id: 'blank', name: 'Blank canvas', description: 'Start empty.', document: empty() };
    expect(parseLayoutPresets({ presets: [preset] })).toEqual([preset]);
    expect(() => parseLayoutPresets({ presets: [preset, preset] })).toThrow('Duplicate');
    expect(() => parseLayoutPresets({ presets: [{ ...preset, document: { version: 2 } }] })).toThrow('version');
    expect(() => parseLayoutPresets({})).toThrow('catalog');
  });
});
