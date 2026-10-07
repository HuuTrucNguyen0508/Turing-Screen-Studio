import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createSampleLayout,
  fitCanvas,
  moveWidget,
  parseCaelestiaPalette,
  parseLayout,
  pointerDeltaToDocument,
  serializeLayout,
  updateGeometry,
  validateLayout,
} from './layout';
import type { LayoutDocument } from './layout';

describe('optional presentation serialization', () => {
  it('omits absent design and orders nested clock overrides canonically without dropping explicit defaults', () => {
    const original = createSampleLayout();
    expect(validateLayout(original).widgets.every((widget) => !Object.hasOwn(widget, 'design'))).toBe(true);
    const clock = { id: 'clock', type: 'clock', x: 0, y: 0, width: 270, height: 80,
      settings: { label: 'Clock', time: '14:32', date: 'Tuesday', format: '24h', showDate: true },
      design: { elements: { date: { color: 'muted', dy: 0 }, time: { color: 'text', size: 40, dy: 0, dx: 0, align: 'start', hidden: false }, label: { hidden: true } }, padding: 29 } };
    const doc = validateLayout({ ...original, widgets: [clock] });
    expect(Object.keys(doc.widgets[0])).toEqual(['id', 'type', 'x', 'y', 'width', 'height', 'settings', 'design']);
    expect(Object.keys(doc.widgets[0].design!)).toEqual(['padding', 'elements']);
    expect(Object.keys(doc.widgets[0].design!.elements!)).toEqual(['label', 'time', 'date']);
    expect(Object.keys(doc.widgets[0].design!.elements!.time!)).toEqual(['hidden', 'align', 'dx', 'dy', 'size', 'color']);
    expect(serializeLayout(parseLayout(serializeLayout(doc)))).toBe(serializeLayout(doc));
    expect(doc.widgets[0].design!.elements!.time!.hidden).toBe(false);
    expect(doc.widgets[0].design!.elements!.time).not.toBe(clock.design.elements.time);
  });

  it('reports design failures through the widget path rather than silently accepting unsupported types', () => {
    const doc = createSampleLayout();
    const designedMetric = { ...doc, widgets: [{ ...doc.widgets[0], design: { padding: 29 } }] };
    expect(() => validateLayout(designedMetric)).toThrow('$.widgets[0].design: metric cards have no editable elements');
  });
});

interface RawLayout {
  [key: string]: unknown;
  version: unknown;
  name: unknown;
  canvas: Record<string, unknown>;
  palette: Record<string, unknown>;
  widgets: Record<string, unknown>[];
}

function rawLayout(): RawLayout {
  return JSON.parse(serializeLayout(createSampleLayout())) as RawLayout;
}

function settings(doc: RawLayout, index = 0): Record<string, unknown> {
  return doc.widgets[index].settings as Record<string, unknown>;
}

function freezeDeep(input: unknown): void {
  if (input !== null && typeof input === 'object') {
    for (const value of Object.values(input)) freezeDeep(value);
    Object.freeze(input);
  }
}

function reverseKeys(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(reverseKeys);
  if (input !== null && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).reverse().map(([key, value]) => [key, reverseKeys(value)]));
  }
  return input;
}

describe('version 1 layout documents', () => {
  it('round-trips every widget ID, setting, palette color, and integer geometry', () => {
    const doc = createSampleLayout();
    expect(parseLayout(serializeLayout(doc))).toEqual(doc);
    expect(doc.canvas).toEqual({ width: 1280, height: 800 });
    expect(doc.widgets.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }))).toEqual([
      { id: 'cpu', x: 64, y: 160, width: 352, height: 224 },
      { id: 'gpu', x: 440, y: 160, width: 352, height: 224 },
      { id: 'memory', x: 64, y: 408, width: 728, height: 240 },
      { id: 'weather', x: 816, y: 160, width: 400, height: 488 },
    ]);
    expect(doc.widgets.map(({ settings: value }) => value)).toEqual([
      { label: 'CPU load', value: '24', unit: '%', detail: '8 cores · 42 °C' },
      { label: 'GPU load', value: '18', unit: '%', detail: '6.2 / 16 GB VRAM' },
      { label: 'Memory', value: '12.4', unit: 'GB', detail: '32 GB installed · 39% used' },
      { location: 'Paris', temperature: '19', unit: '°C', condition: 'Partly cloudy', high: '22', low: '14' },
    ]);
  });

  it('ships exactly the same sample JSON, including canonical formatting', () => {
    const bundled = readFileSync(new URL('../../public/sample-layout.json', import.meta.url), 'utf8');
    expect(bundled).toBe(serializeLayout(createSampleLayout()));
    expect(parseLayout(bundled)).toEqual(createSampleLayout());
  });

  it('serializes deterministically regardless of imported object key order', () => {
    const doc = createSampleLayout();
    const text = serializeLayout(doc);
    expect(serializeLayout(validateLayout(reverseKeys(doc)))).toBe(text);
    expect(serializeLayout(parseLayout(text))).toBe(text);
    expect(text).toContain('\n  "version": 1,\n');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('returns fresh samples and detached validation results without mutating input', () => {
    const source = createSampleLayout();
    freezeDeep(source);
    const validated = validateLayout(source);
    validated.canvas.width = 1000;
    validated.palette.primary = '#ffffff';
    if (validated.widgets[0].type === 'metric') validated.widgets[0].settings.unit = 'changed';
    validated.widgets[0].x = 2;
    expect(source).toEqual(createSampleLayout());
    const next = createSampleLayout();
    expect(next).not.toBe(source);
    expect(next.widgets[0].settings).not.toBe(source.widgets[0].settings);
  });

  it.each([null, [], true, 1, 'text', new Date()].map((input) => ({ input })))('rejects non-document input $input', ({ input }) => {
    expect(() => validateLayout(input)).toThrow('$:');
  });

  it('reports malformed JSON and validates parsed scalar JSON', () => {
    expect(() => parseLayout('{')).toThrow('$: invalid JSON:');
    expect(() => parseLayout('null')).toThrow('$: expected an object');
  });

  it('reports unsupported versions before missing or future-version fields', () => {
    expect(() => parseLayout('{"version":2}')).toThrow('$.version: unsupported layout version; expected 1');
    expect(() => parseLayout('{"version":2,"futureSetting":true}')).toThrow('$.version: unsupported layout version; expected 1');
    expect(() => parseLayout('{"colours":{}}')).toThrow('$.version: required field is missing');
  });

  it('round-trips optional live sources and palette mode without adding them to old layouts', () => {
    const doc = createSampleLayout();
    expect(parseLayout(serializeLayout(doc))).not.toHaveProperty('paletteMode');
    doc.paletteMode = 'live';
    if (doc.widgets[0].type === 'metric') doc.widgets[0].settings.source = 'cpu';
    if (doc.widgets[3].type === 'weather') doc.widgets[3].settings.source = 'weather';
    expect(parseLayout(serializeLayout(doc))).toEqual(doc);
    expect(() => validateLayout({ ...doc, paletteMode: 'unknown' })).toThrow('$.paletteMode');
    const raw = rawLayout();
    settings(raw).source = 'weather';
    expect(() => validateLayout(raw)).toThrow('$.widgets[0].settings.source');
    settings(raw, 3).source = 'cpu';
    settings(raw).source = 'cpu';
    expect(() => validateLayout(raw)).toThrow('$.widgets[3].settings.source');
  });

  const rejectionCases: { label: string; path: string; edit: (doc: RawLayout) => void }[] = [
    { label: 'unsupported version', path: '$.version', edit: (doc) => { doc.version = 2; } },
    { label: 'string version', path: '$.version', edit: (doc) => { doc.version = '1'; } },
    { label: 'empty name', path: '$.name', edit: (doc) => { doc.name = ' '; } },
    { label: 'missing name', path: '$.name', edit: (doc) => { delete (doc as Record<string, unknown>).name; } },
    { label: 'unknown document field', path: '$.extra', edit: (doc) => { doc.extra = true; } },
    { label: 'zero canvas width', path: '$.canvas.width', edit: (doc) => { doc.canvas.width = 0; } },
    { label: 'negative canvas height', path: '$.canvas.height', edit: (doc) => { doc.canvas.height = -1; } },
    { label: 'fractional canvas', path: '$.canvas.width', edit: (doc) => { doc.canvas.width = 1280.5; } },
    { label: 'oversized canvas', path: '$.canvas.width', edit: (doc) => { doc.canvas.width = 16385; } },
    { label: 'unsafe canvas', path: '$.canvas.height', edit: (doc) => { doc.canvas.height = Number.MAX_SAFE_INTEGER + 1; } },
    { label: 'unknown canvas field', path: '$.canvas.scale', edit: (doc) => { doc.canvas.scale = 1; } },
    { label: 'missing canvas dimension', path: '$.canvas.height', edit: (doc) => { delete doc.canvas.height; } },
    { label: 'missing palette field', path: '$.palette.outline', edit: (doc) => { delete doc.palette.outline; } },
    { label: 'unknown palette field', path: '$.palette.accent', edit: (doc) => { doc.palette.accent = '#ffffff'; } },
    { label: 'short palette color', path: '$.palette.primary', edit: (doc) => { doc.palette.primary = '#fff'; } },
    { label: 'bare palette color', path: '$.palette.primary', edit: (doc) => { doc.palette.primary = 'ffffff'; } },
    { label: 'nonhex palette color', path: '$.palette.text', edit: (doc) => { doc.palette.text = '#zzzzzz'; } },
    { label: 'color with trailing newline', path: '$.palette.primary', edit: (doc) => { doc.palette.primary = '#ffffff\n'; } },
    { label: 'numeric palette color', path: '$.palette.text', edit: (doc) => { doc.palette.text = 123456; } },
    { label: 'nonstring palette name', path: '$.palette.name', edit: (doc) => { doc.palette.name = null; } },
    { label: 'nonarray widgets', path: '$.widgets', edit: (doc) => { (doc as Record<string, unknown>).widgets = {}; } },
    { label: 'duplicate ID', path: '$.widgets[1].id', edit: (doc) => { doc.widgets[1].id = doc.widgets[0].id; } },
    { label: 'blank ID', path: '$.widgets[0].id', edit: (doc) => { doc.widgets[0].id = ' '; } },
    { label: 'unsupported widget', path: '$.widgets[0].type', edit: (doc) => { doc.widgets[0].type = 'unsupported'; } },
    { label: 'unknown widget field', path: '$.widgets[0].rotation', edit: (doc) => { doc.widgets[0].rotation = 0; } },
    { label: 'missing geometry', path: '$.widgets[0].x', edit: (doc) => { delete doc.widgets[0].x; } },
    { label: 'fractional coordinate', path: '$.widgets[0].x', edit: (doc) => { doc.widgets[0].x = 0.5; } },
    { label: 'negative coordinate', path: '$.widgets[0].y', edit: (doc) => { doc.widgets[0].y = -1; } },
    { label: 'unsafe coordinate', path: '$.widgets[0].x', edit: (doc) => { doc.widgets[0].x = Number.MAX_SAFE_INTEGER + 1; } },
    { label: 'nonfinite coordinate', path: '$.widgets[0].x', edit: (doc) => { doc.widgets[0].x = Infinity; } },
    { label: 'NaN coordinate', path: '$.widgets[0].x', edit: (doc) => { doc.widgets[0].x = NaN; } },
    { label: 'zero size', path: '$.widgets[0].width', edit: (doc) => { doc.widgets[0].width = 0; } },
    { label: 'negative size', path: '$.widgets[0].height', edit: (doc) => { doc.widgets[0].height = -5; } },
    { label: 'fractional size', path: '$.widgets[0].height', edit: (doc) => { doc.widgets[0].height = 224.5; } },
    { label: 'right overflow', path: '$.widgets[0].width', edit: (doc) => { doc.widgets[0].x = 929; } },
    { label: 'bottom overflow', path: '$.widgets[0].height', edit: (doc) => { doc.widgets[0].y = 577; } },
    { label: 'missing metric setting', path: '$.widgets[0].settings.detail', edit: (doc) => { delete settings(doc).detail; } },
    { label: 'unexpected metric setting', path: '$.widgets[0].settings.location', edit: (doc) => { settings(doc).location = 'Paris'; } },
    { label: 'numeric metric setting', path: '$.widgets[0].settings.value', edit: (doc) => { settings(doc).value = 24; } },
    { label: 'missing weather setting', path: '$.widgets[3].settings.high', edit: (doc) => { delete settings(doc, 3).high; } },
    { label: 'unexpected weather setting', path: '$.widgets[3].settings.label', edit: (doc) => { settings(doc, 3).label = 'weather'; } },
    { label: 'null settings', path: '$.widgets[0].settings', edit: (doc) => { doc.widgets[0].settings = null; } },
  ];

  it.each(rejectionCases)('rejects $label with a field path', ({ edit, path }) => {
    const input = rawLayout();
    edit(input);
    expect(() => validateLayout(input)).toThrow(path);
  });

  it('rejects holes in arrays passed directly to validation', () => {
    const input = rawLayout();
    delete input.widgets[0];
    expect(() => validateLayout(input)).toThrow('$.widgets[0]');
  });

  it('rejects hidden and symbol fields on objects passed directly to validation', () => {
    const hidden = rawLayout();
    Object.defineProperty(hidden.canvas, 'scale', { value: 1 });
    expect(() => validateLayout(hidden)).toThrow('$.canvas.scale');
    const symbolic = rawLayout();
    Object.defineProperty(symbolic.palette, Symbol('extra'), { value: '#ffffff' });
    expect(() => validateLayout(symbolic)).toThrow('$.palette.Symbol(extra)');
  });

  it('allows exact boundaries, the maximum canvas size, and empty setting strings', () => {
    const input = rawLayout();
    input.canvas.width = 16384;
    input.canvas.height = 16384;
    input.widgets[0].x = 16384 - 352;
    input.widgets[0].y = 16384 - 224;
    settings(input).unit = '';
    expect(validateLayout(input).widgets[0].x).toBe(16032);
  });

  it('validates before serializing and leaves the current document intact on import failure', () => {
    const current = createSampleLayout();
    const saved = serializeLayout(current);
    const invalid = { ...current, version: 2 } as unknown as LayoutDocument;
    expect(() => serializeLayout(invalid)).toThrow('$.version');
    expect(() => parseLayout('{"version":2}')).toThrow();
    expect(serializeLayout(current)).toBe(saved);
  });
});

describe('immutable geometry edits', () => {
  it('clamps movement on all four edges while preserving dimensions', () => {
    const doc = createSampleLayout();
    expect(updateGeometry(doc, 'cpu', { x: -999, y: -999 }).widgets[0]).toMatchObject({ x: 0, y: 0, width: 352, height: 224 });
    const far = moveWidget(doc, 'cpu', 10000, 10000);
    expect(far.widgets[0]).toMatchObject({ x: 928, y: 576, width: 352, height: 224 });
    expect(validateLayout(far)).toEqual(far);
  });

  it('clamps sizes to remaining canvas dimensions and a minimum of one pixel', () => {
    const doc = createSampleLayout();
    const large = updateGeometry(doc, 'weather', { width: 10000, height: 10000 });
    expect(large.widgets[3]).toMatchObject({ x: 816, y: 160, width: 464, height: 640 });
    const tiny = updateGeometry(doc, 'weather', { width: -100, height: 0 });
    expect(tiny.widgets[3]).toMatchObject({ x: 816, y: 160, width: 1, height: 1 });
    expect(validateLayout(large)).toEqual(large);
    expect(validateLayout(tiny)).toEqual(tiny);
  });

  it('resizes at the current position before clamping a simultaneous move', () => {
    const doc = updateGeometry(createSampleLayout(), 'cpu', { width: 2000, height: 2000, x: 1000, y: 700 });
    expect(doc.widgets[0]).toMatchObject({ x: 64, y: 160, width: 1216, height: 640 });
    expect(validateLayout(doc)).toEqual(doc);
  });

  it('rounds numeric fields and keeps untouched objects and settings by reference', () => {
    const doc = createSampleLayout();
    const before = serializeLayout(doc);
    freezeDeep(doc);
    const changed = updateGeometry(doc, 'cpu', { x: 65.7, y: 159.2, width: 351.6, height: 223.2 });
    expect(changed.widgets[0]).toMatchObject({ x: 66, y: 159, width: 352, height: 223 });
    expect(changed).not.toBe(doc);
    expect(changed.widgets).not.toBe(doc.widgets);
    expect(changed.widgets[0].settings).toBe(doc.widgets[0].settings);
    expect(changed.widgets[1]).toBe(doc.widgets[1]);
    expect(changed.canvas).toBe(doc.canvas);
    expect(changed.palette).toBe(doc.palette);
    expect(serializeLayout(doc)).toBe(before);
  });

  it('preserves the document reference for empty, rounded, and clamped no-ops', () => {
    const doc = createSampleLayout();
    expect(updateGeometry(doc, 'cpu', {})).toBe(doc);
    expect(updateGeometry(doc, 'cpu', { x: 64.1 })).toBe(doc);
    expect(moveWidget(doc, 'cpu', 0, 0)).toBe(doc);
    const atEdge = updateGeometry(doc, 'cpu', { x: 0, y: 0 });
    expect(moveWidget(atEdge, 'cpu', -1, -1)).toBe(atEdge);
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite edits and deltas %s', (value) => {
    const doc = createSampleLayout();
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(() => updateGeometry(doc, 'cpu', { [key]: value })).toThrow(`$.geometry.${key}`);
    }
    expect(() => moveWidget(doc, 'cpu', value, 0)).toThrow('$.delta.x');
    expect(() => moveWidget(doc, 'cpu', 0, value)).toThrow('$.delta.y');
  });

  it('reports missing IDs and rejects unexpected or nonnumeric edits', () => {
    const doc = createSampleLayout();
    expect(() => moveWidget(doc, 'missing', 1, 0)).toThrow('widget ID "missing"');
    expect(() => updateGeometry(doc, 'missing', {})).toThrow('widget ID "missing"');
    expect(() => updateGeometry(doc, 'cpu', { x: '4' } as unknown as { x: number })).toThrow('$.geometry.x');
    expect(() => updateGeometry(doc, 'cpu', { x: undefined })).toThrow('$.geometry.x');
    expect(() => updateGeometry(doc, 'cpu', { z: 1 } as unknown as { x: number })).toThrow('$.geometry.z');
  });
});

describe('preview coordinate conversion', () => {
  it.each([0.25, 0.5, 1])('nudges exactly one document pixel at scale %s', (scale) => {
    const doc = createSampleLayout();
    expect(fitCanvas(1280, 800, 1280 * scale, 800 * scale).scale).toBe(scale);
    const nudged = moveWidget(doc, 'cpu', 1, -1);
    expect(nudged.widgets[0]).toMatchObject({ x: 65, y: 159 });
    expect(pointerDeltaToDocument(scale, -scale, scale)).toEqual({ x: 1, y: -1 });
  });

  it('centers horizontal and vertical letterboxes without changing saved geometry', () => {
    const doc = createSampleLayout();
    const before = serializeLayout(doc);
    expect(fitCanvas(1280, 800, 1000, 400)).toEqual({ scale: 0.5, offsetX: 180, offsetY: 0 });
    expect(fitCanvas(1280, 800, 640, 600)).toEqual({ scale: 0.5, offsetX: 0, offsetY: 100 });
    expect(fitCanvas(1280, 800, 2560, 1600)).toEqual({ scale: 2, offsetX: 0, offsetY: 0 });
    expect(serializeLayout(doc)).toBe(before);
  });

  it.each([0.25, 0.5, 1])('rounds fractional total displacement without cumulative drift at scale %s', (scale) => {
    const origin = createSampleLayout();
    let dragged = origin;
    for (let step = 1; step <= 20; step++) {
      const delta = pointerDeltaToDocument(step / 10, -step / 10, scale);
      dragged = updateGeometry(origin, 'cpu', { x: 64 + delta.x, y: 160 + delta.y });
    }
    const final = pointerDeltaToDocument(2, -2, scale);
    expect(dragged).toEqual(moveWidget(origin, 'cpu', final.x, final.y));
    const returned = pointerDeltaToDocument(0, 0, scale);
    expect(updateGeometry(origin, 'cpu', { x: 64 + returned.x, y: 160 + returned.y })).toBe(origin);
    expect(pointerDeltaToDocument(0.49 * scale, -0.49 * scale, scale)).toEqual({ x: 0, y: 0 });
  });

  it.each([0, -1, NaN, Infinity])('rejects an unusable scale or viewport dimension %s', (value) => {
    expect(() => pointerDeltaToDocument(1, 1, value)).toThrow('$.scale');
    expect(() => fitCanvas(1280, 800, value, 800)).toThrow('$.viewport.width');
    expect(() => fitCanvas(value, 800, 1280, 800)).toThrow('$.canvas.width');
  });

  it('rejects nonfinite pointer movement', () => {
    expect(() => pointerDeltaToDocument(Infinity, 0, 1)).toThrow('$.pointer.x');
    expect(() => pointerDeltaToDocument(0, NaN, 1)).toThrow('$.pointer.y');
  });
});

describe('Caelestia palette import', () => {
  const colours = {
    background: '0a0f0f', surfaceContainer: '131b1b', surfaceContainerHigh: '#192121',
    onSurface: 'DCE8E7', onSurfaceVariant: 'a2adad', primary: '#9bd0d1',
    secondary: 'b0cccc', outlineVariant: '3f4a4a',
    surface: '000000', outline: 'ffffff', unrelated: 'ignored',
  };

  it('maps the required Material roles, accepts optional hashes, and normalizes case', () => {
    expect(parseCaelestiaPalette(JSON.stringify({ name: 'dynamic', colours, mode: 'dark' })))
      .toEqual(createSampleLayout().palette);
  });

  it('uses Caelestia as the name when no name was supplied', () => {
    expect(parseCaelestiaPalette(JSON.stringify({ colours })).name).toBe('Caelestia');
  });

  it.each(['fff', '#12345g', '##123456', '12345678', ' #123456', '#123456\n', ''])('rejects invalid imported color %s', (value) => {
    expect(() => parseCaelestiaPalette(JSON.stringify({ colours: { ...colours, primary: value } })))
      .toThrow('$.colours.primary');
  });

  it('reports missing roles, nonstring colors, invalid names, and malformed schemes', () => {
    const missing: Record<string, unknown> = { ...colours };
    delete missing.surfaceContainer;
    expect(() => parseCaelestiaPalette(JSON.stringify({ colours: missing }))).toThrow('$.colours.surfaceContainer');
    expect(() => parseCaelestiaPalette(JSON.stringify({ colours: { ...colours, primary: 123456 } }))).toThrow('$.colours.primary');
    expect(() => parseCaelestiaPalette(JSON.stringify({ name: 42, colours }))).toThrow('$.name');
    expect(() => parseCaelestiaPalette('{}')).toThrow('$.colours');
    expect(() => parseCaelestiaPalette('null')).toThrow('$:');
    expect(() => parseCaelestiaPalette('{')).toThrow('invalid JSON');
  });
});
