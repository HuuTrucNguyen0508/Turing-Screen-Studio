import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { effectiveWidgetPalette, updateWidgetColor } from './colors';
import { createSampleLayout, paletteColorKeys, parseLayout, serializeLayout, validateLayout } from './layout';
import type { PaletteColorKey } from './layout';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg==';

function allWidgets() {
  const sample = createSampleLayout();
  const base = { x: 0, y: 0, width: 270, height: 224 };
  return validateLayout({ ...sample, widgets: [
    sample.widgets[0], sample.widgets[3],
    { ...base, id: 'clock', type: 'clock', settings: { label: 'Clock', time: '14:32', date: 'Today', format: '12h', showDate: true }, design: { elements: { time: { color: '#123456' } } } },
    { ...base, id: 'text', type: 'text', settings: { label: 'Note', text: 'Saved' } },
    { ...base, id: 'gauge', type: 'gauge', settings: { label: 'CPU', value: 42, min: 0, max: 100, unit: '%', detail: 'Sample' } },
    { ...base, id: 'storage', type: 'storage', settings: { label: 'Drives', style: 'bars' } },
    { ...base, id: 'image', type: 'image', settings: { label: 'Icon', data: png, fit: 'contain', opacity: 100 } },
  ] });
}

function python(script: string, input: unknown): string {
  return execFileSync('python3', ['-c', script], {
    input: JSON.stringify(input), env: { ...process.env, PYTHONPATH: 'runtime' }, encoding: 'utf8',
  });
}

describe('saved widget palette overrides', () => {
  it('exports all eight roles, preserves old omission and canonicalizes detached overrides for every type', () => {
    expect(paletteColorKeys).toEqual(['background', 'surface', 'surfaceRaised', 'text', 'muted', 'primary', 'secondary', 'outline']);
    const original = allWidgets();
    expect(original.widgets.every((widget) => !Object.hasOwn(widget, 'colors'))).toBe(true);
    const colors = Object.fromEntries([...paletteColorKeys].reverse().map((key) => [key, '#aB12Cd']));
    const raw = { ...original, widgets: original.widgets.map((widget) => ({ ...widget, colors })) };
    const canonical = validateLayout(raw);
    expect(parseLayout(serializeLayout(canonical))).toEqual(canonical);
    for (const widget of canonical.widgets) {
      expect(Object.keys(widget.colors!)).toEqual(paletteColorKeys);
      expect(Object.keys(widget).at(-1)).toBe('colors');
      expect(widget.colors).not.toBe(colors);
    }
    canonical.widgets[0].colors!.primary = '#ffffff';
    expect(colors.primary).toBe('#aB12Cd');
    const script = 'import json,sys\nfrom turzx_studio.layout import serialize_layout\nprint(serialize_layout(json.load(sys.stdin)),end="")';
    expect(python(script, raw)).toBe(serializeLayout(raw));
  });

  it('merges only saved card overrides over either palette without changing its name or neighboring cards', () => {
    const doc = createSampleLayout();
    const widget = { ...doc.widgets[0], colors: { primary: '#123456', surface: '#654321' } };
    for (const base of [doc.palette, { ...doc.palette, name: 'Live scheme', text: '#abcdef', primary: '#fedcba' }]) {
      const palette = effectiveWidgetPalette(base, widget);
      expect(palette).toEqual({ ...base, primary: '#123456', surface: '#654321' });
      expect(palette).not.toBe(base);
      palette.text = '#000000';
      expect(base.text).not.toBe('#000000');
      expect(effectiveWidgetPalette(base, doc.widgets[1])).toEqual(base);
    }
  });

  it('sets and resets individual roles immutably, prunes the last reset and preserves no-ops', () => {
    const doc = createSampleLayout();
    Object.freeze(doc.widgets[0]);
    expect(updateWidgetColor(doc, 'cpu', 'primary', null)).toBe(doc);
    const primary = updateWidgetColor(doc, 'cpu', 'primary', '#A1b2C3');
    expect(doc.widgets[0].colors).toBeUndefined();
    expect(primary.widgets[0].colors).toEqual({ primary: '#A1b2C3' });
    expect(primary.widgets[0].settings).toBe(doc.widgets[0].settings);
    expect(primary.widgets[1]).toBe(doc.widgets[1]);
    expect(updateWidgetColor(primary, 'cpu', 'primary', '#A1b2C3')).toBe(primary);
    Object.freeze(primary.widgets[0].colors);
    const multiple = updateWidgetColor(primary, 'cpu', 'surface', '#010203');
    expect(Object.keys(multiple.widgets[0].colors!)).toEqual(['surface', 'primary']);
    const reset = updateWidgetColor(multiple, 'cpu', 'primary', null);
    expect(reset.widgets[0].colors).toEqual({ surface: '#010203' });
    const restored = updateWidgetColor(reset, 'cpu', 'surface', null);
    expect(Object.hasOwn(restored.widgets[0], 'colors')).toBe(false);
    expect(serializeLayout(restored)).toBe(serializeLayout(doc));
    expect(() => updateWidgetColor(doc, 'missing', 'primary', '#123456')).toThrow('widget ID "missing" was not found');
    expect(() => updateWidgetColor(doc, 'cpu', 'name' as PaletteColorKey, '#123456')).toThrow('colors.name: unexpected field');
    expect(() => updateWidgetColor(doc, 'cpu', 'primary', '#abc')).toThrow('colors.primary: expected a six-digit #hex color');
  });

  it('matches Python failures for empty, unknown, non-object and malformed overrides', () => {
    const invalid = [null, [], true, 42, 'primary', {}, { name: '#123456' }, { bogus: '#123456' },
      ...['#abc', '#12345', '#1234567', '#12345g', '#123456\n', 'red', '123456', '', true, 42, null].map((primary) => ({ primary }))];
    const docs = invalid.map((colors) => {
      const doc = createSampleLayout();
      return { ...doc, widgets: [{ ...doc.widgets[0], colors }] };
    });
    const errors = docs.map((doc) => {
      try { validateLayout(doc); return ''; } catch (error) { return (error as Error).message; }
    });
    expect(errors.every((error) => error.startsWith('$.widgets[0].colors'))).toBe(true);
    const script = 'import json,sys\nfrom turzx_studio.layout import validate_layout\nresult=[]\nfor v in json.load(sys.stdin):\n try: validate_layout(v)\n except ValueError as e: result.append(str(e))\nprint(json.dumps(result))';
    expect(JSON.parse(python(script, docs))).toEqual(errors);
  });

  it('rejects own symbol keys and objects with non-JSON prototypes or explicit undefined values', () => {
    const doc = createSampleLayout();
    for (const colors of [new Date(), Object.create({ primary: '#123456' }), { [Symbol('text')]: '#123456' }, { primary: undefined }]) {
      expect(() => validateLayout({ ...doc, widgets: [{ ...doc.widgets[0], colors }] })).toThrow('$.widgets[0].colors');
    }
  });

  it('publishes strict schema color definitions for all widget kinds and literal clock text', () => {
    const schema = JSON.parse(readFileSync(new URL('../../public/layout.schema.json', import.meta.url), 'utf8'));
    const definition = schema.$defs.widgetColors;
    expect(definition.additionalProperties).toBe(false);
    expect(definition.minProperties).toBe(1);
    expect(Object.keys(definition.properties)).toEqual(paletteColorKeys);
    for (const value of Object.values(definition.properties)) {
      expect(value).toEqual({ type: 'string', minLength: 7, maxLength: 7, pattern: '^#[0-9a-fA-F]{6}$' });
    }
    for (const widget of schema.properties.widgets.items.oneOf) {
      expect(widget.properties.colors).toEqual({ $ref: '#/$defs/widgetColors' });
      expect(widget.required).not.toContain('colors');
    }
    expect(schema.$defs.clockElementDesign.properties.color.oneOf).toEqual([
      { enum: ['text', 'muted', 'primary', 'secondary'] },
      { type: 'string', minLength: 7, maxLength: 7, pattern: '^#[0-9a-fA-F]{6}$' },
    ]);
  });
});
