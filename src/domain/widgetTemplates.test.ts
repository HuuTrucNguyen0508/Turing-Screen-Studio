import { describe, expect, it } from 'vitest';
import { createSampleLayout, serializeLayout, validateLayout } from './layout';
import type { ClockWidget, LayoutDocument, Widget } from './layout';
import { MAX_CUSTOM_BYTES, MAX_CUSTOM_WIDGETS, MAX_WIDGET_IMPORT_BYTES, mergeCustomWidgets, parseCustomWidgets, parseWidgetImport, placedTemplate, serializeCustomWidgets, templateWidget, validateCustomWidgets } from './widgetTemplates';

const sample = () => ({ version: 1 as const, widgets: [{ id: 'my-cpu', name: 'My CPU', widget: templateWidget(createSampleLayout().widgets[0]) }] });
describe('custom widget copies', () => {
  it('roundtrips without document identity and returns detached placements', () => {
    const original = sample();
    const recovered = parseCustomWidgets(serializeCustomWidgets(original));
    expect(recovered).toEqual(original);
    expect(recovered.widgets[0].widget).not.toHaveProperty('id');
    expect(recovered.widgets[0].widget).not.toHaveProperty('x');
    const placed = placedTemplate(recovered.widgets[0]);
    if (placed.type !== 'metric') throw new Error('Expected sample metric');
    placed.settings.label = 'Edited instance';
    expect(recovered.widgets[0].widget.settings).toMatchObject({ label: 'CPU load' });
  });
  it('imports additively with unique names and IDs and skips identical copies', () => {
    const current = sample(), imported = sample();
    expect(mergeCustomWidgets(current, imported)).toMatchObject({ added: 0, skipped: 1 });
    if (!('label' in imported.widgets[0].widget.settings)) throw new Error('Expected sample label');
    imported.widgets[0].widget.settings.label = 'New content';
    const result = mergeCustomWidgets(current, imported);
    expect(result).toMatchObject({ added: 1, skipped: 0 });
    expect(result.document.widgets[1]).toMatchObject({ id: 'my-cpu-2', name: 'My CPU (imported)' });
    expect(current.widgets).toHaveLength(1);
  });
  it('rejects invalid imports and capacity overflow without changing the original', () => {
    const current = sample();
    expect(() => validateCustomWidgets({ ...current, widgets: [current.widgets[0], { ...current.widgets[0], id: 'other', name: 'MY CPU' }] })).toThrow();
    expect(() => validateCustomWidgets({ version: 1, widgets: [{ ...current.widgets[0], widget: { ...current.widgets[0].widget, x: 0 } }] })).toThrow();
    const full = { version: 1 as const, widgets: Array.from({ length: 64 }, (_, index) => ({ ...current.widgets[0], id: `widget-${index}`, name: `Widget ${index}`, widget: { ...current.widgets[0].widget, settings: { ...current.widgets[0].widget.settings, label: `Label ${index}` } } })) };
    expect(() => mergeCustomWidgets(full, current)).toThrow();
    expect(full.widgets).toHaveLength(64);
  });
});


it('uses UTF-16 name limits and JavaScript whitespace consistently', () => {
  const current = sample();
  for (const name of ['😀'.repeat(31), '\ufeff']) {
    expect(() => validateCustomWidgets({ version: 1, widgets: [{ ...current.widgets[0], name }] })).toThrow();
  }
  expect(validateCustomWidgets({ version: 1, widgets: [{ ...current.widgets[0], name: '\ufeff' + '😀'.repeat(30) + '\ufeff' }] }).widgets[0].name).toBe('😀'.repeat(30));
});

const clock = (): ClockWidget => ({
  id: 'Local Clock / Paris', type: 'clock', x: 1400, y: 800, width: 400, height: 200,
  settings: { label: '  Local time  ', time: '14:32', date: 'Wednesday, 7 October', format: '12h', showDate: true, source: 'clock' },
  design: { padding: 40, elements: { label: { hidden: false }, time: { align: 'center', dx: 12, dy: -4, size: 81, color: 'secondary' }, date: { align: 'end', hidden: true } } },
});
const customLayout = (): LayoutDocument => ({
  ...createSampleLayout(), canvas: { width: 1920, height: 1080 }, chrome: 'none', paletteMode: 'live',
  widgets: [...createSampleLayout().widgets, clock()],
});
const importJson = (raw: unknown) => parseWidgetImport(JSON.stringify(raw));
const textCard = (text: string): Widget => ({
  id: 'text', type: 'text', x: 0, y: 0, width: 1280, height: 800, settings: { label: 'Notes', text },
});

describe('widget file imports', () => {
  it('extracts every card from a fully validated custom-size layout and retains clock design', () => {
    const original = customLayout(), before = structuredClone(original);
    const imported = parseWidgetImport(serializeLayout(original));
    expect(imported.widgets).toHaveLength(original.widgets.length);
    expect(imported.widgets.map((entry) => entry.widget)).toEqual(original.widgets.map(templateWidget));
    expect(imported.widgets.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'cpu', name: 'CPU load' }, { id: 'gpu', name: 'GPU load' }, { id: 'memory', name: 'Memory' },
      { id: 'weather', name: 'weather' }, { id: 'local-clock---paris', name: 'Local time' },
    ]);
    const placed = placedTemplate(imported.widgets[4]);
    expect(placed).toMatchObject({ x: 0, y: 0, width: 400, height: 200, design: clock().design });
    expect(parseCustomWidgets(serializeCustomWidgets(imported))).toEqual(imported);
    placed.design!.elements!.time!.dx = 0;
    expect(imported.widgets[4].widget.design?.elements?.time?.dx).toBe(12);
    expect(original).toEqual(before);
  });

  it('accepts widget packs, named templates, bare templates and single placements without broadening storage parsing', () => {
    const pack = sample();
    expect(importJson(pack)).toEqual(pack);
    expect(importJson(pack.widgets[0])).toEqual(pack);
    const single = importJson(clock());
    expect(single.widgets[0]).toEqual({ id: 'local-clock---paris', name: 'Local time', widget: templateWidget(clock()) });
    expect(importJson(templateWidget(clock())).widgets[0]).toEqual({ id: 'widget', name: 'Local time', widget: templateWidget(clock()) });
    for (const raw of [customLayout(), pack.widgets[0], clock(), templateWidget(clock())]) {
      expect(() => parseCustomWidgets(JSON.stringify(raw))).toThrow();
    }
    expect(() => parseCustomWidgets('{')).toThrow(SyntaxError);
  });

  it('makes bounded case-insensitive names and sanitized IDs unique without dropping identical cards', () => {
    const original = customLayout();
    const label = '😀'.repeat(30);
    original.widgets = [
      { ...clock(), id: 'Same/Card', settings: { ...clock().settings, label } },
      { ...clock(), id: 'same?card', settings: { ...clock().settings, label } },
      { ...clock(), id: '---', settings: { ...clock().settings, label: '   ' } },
      { ...clock(), id: '🕒', settings: { ...clock().settings, label: 'CLOCK' } },
      { ...clock(), id: 'A'.repeat(100), settings: { ...clock().settings, label: 'Clock' } },
      { ...clock(), id: 'A'.repeat(99) + 'B', settings: { ...clock().settings, label: 'Clock (2)' } },
    ];
    const imported = importJson(original);
    expect(imported.widgets).toHaveLength(6);
    expect(imported.widgets.map((entry) => entry.id)).toEqual(['same-card', 'same-card-2', 'widget', 'widget-2', 'a'.repeat(42), 'a'.repeat(42) + '-2']);
    expect(imported.widgets.map((entry) => entry.name)).toEqual([label, label.slice(0, 56) + ' (2)', 'clock', 'CLOCK (2)', 'Clock (3)', 'Clock (2) (2)']);
    expect(imported.widgets.every((entry) => entry.name.length <= 60)).toBe(true);
    expect(imported.widgets[0].widget).toEqual(imported.widgets[1].widget);
  });

  it('merges extracted cards additively, deduplicates content and preserves both inputs', () => {
    const current = sample(), layout = customLayout();
    layout.widgets = [
      { ...createSampleLayout().widgets[0], id: 'duplicate-position', x: 900 },
      { ...createSampleLayout().widgets[0], id: 'my-cpu', settings: { ...createSampleLayout().widgets[0].settings, value: '99' } } as Widget,
      clock(), { ...clock(), id: 'duplicate-clock' },
    ];
    const imported = importJson(layout), beforeCurrent = structuredClone(current), beforeImported = structuredClone(imported);
    const merged = mergeCustomWidgets(current, imported);
    expect(merged).toMatchObject({ added: 2, skipped: 2 });
    expect(merged.document.widgets[1]).toMatchObject({ id: 'my-cpu-2', name: 'CPU load (2)' });
    expect(merged.document.widgets[2].widget.design).toEqual(clock().design);
    merged.document.widgets[2].widget.design!.elements!.time!.size = 20;
    expect(current).toEqual(beforeCurrent);
    expect(imported).toEqual(beforeImported);
  });

  it('resolves name collisions after truncation and whitespace normalization', () => {
    const label = 'a'.repeat(59);
    const original = { ...customLayout(), widgets: [
      { ...clock(), id: 'first', settings: { ...clock().settings, label: label + ' more' } },
      { ...clock(), id: 'second', settings: { ...clock().settings, label: label.toUpperCase() } },
    ] };
    expect(importJson(original).widgets.map((entry) => entry.name)).toEqual([label, 'A'.repeat(56) + ' (2)']);
  });

  it.each([
    'export default { render() { return document.cookie; } }', '<html><script>alert(1)</script></html>',
    '{', 'null', '[]', '"clock"', '{}', '{"format":"rainmeter","code":"run()"}',
    '{"type":"script","width":100,"height":100,"settings":{"code":"run()"}}',
    '{"version":1,"widgets":[],"script":"run()"}',
  ])('rejects malformed or unsupported files with supported-format guidance: %s', (raw) => {
    expect(() => parseWidgetImport(raw)).toThrow('Supported formats: Studio widget pack, Studio layout, single placed Studio widget, or Studio template JSON.');
  });

  it.each([
    ['unsupported version', (doc: LayoutDocument) => ({ ...doc, version: 2 }), '$.version'],
    ['duplicate IDs', (doc: LayoutDocument) => ({ ...doc, widgets: [...doc.widgets, doc.widgets[0]] }), 'duplicate widget ID'],
    ['invalid palette', (doc: LayoutDocument) => ({ ...doc, palette: { ...doc.palette, primary: 'red' } }), '$.palette.primary'],
    ['fractional position', (doc: LayoutDocument) => ({ ...doc, widgets: [...doc.widgets, { ...clock(), id: 'bad', x: 1.5 }] }), '$.widgets[5].x'],
    ['out of bounds', (doc: LayoutDocument) => ({ ...doc, widgets: [...doc.widgets, { ...clock(), id: 'bad', x: 1900 }] }), '$.widgets[5].width'],
    ['executable field', (doc: LayoutDocument) => ({ ...doc, widgets: [...doc.widgets, { ...clock(), id: 'bad', script: 'run()' }] }), '$.widgets[5].script'],
    ['unsupported design', (doc: LayoutDocument) => ({ ...doc, widgets: [...doc.widgets, { ...clock(), id: 'bad', design: { elements: { script: { hidden: true } } } }] }), '$.widgets[5].design.elements.script'],
  ])('validates the entire layout before extraction: %s', (_name, invalidate, path) => {
    const original = customLayout(), before = structuredClone(original);
    expect(() => importJson(invalidate(original))).toThrow(path);
    expect(original).toEqual(before);
  });

  it('validates original single-widget geometry and strict template fields before removing placement', () => {
    for (const patch of [{ x: -1 }, { x: 1.5 }, { y: -1 }, { x: 16384 }, { x: undefined }, { id: '' }, { height: 0 }, { script: 'run()' }]) {
      expect(() => importJson({ ...clock(), ...patch })).toThrow();
    }
    for (const patch of [{ x: 0 }, { name: 'Ignored name' }, { id: 'Missing position' }, { settings: {} }]) {
      expect(() => importJson({ ...templateWidget(clock()), ...patch })).toThrow();
    }
    expect(() => importJson({ ...sample().widgets[0], name: '' })).toThrow('.name');
    expect(() => importJson({ ...sample().widgets[0], script: 'run()' })).toThrow('expected id, name, widget');
  });

  it.each([{ width: 1281, height: 200 }, { width: 400, height: 801 }, { width: 16384, height: 16384 }])('rejects oversized cards with a resize instruction and preserves the source: %j', (size) => {
    const original: LayoutDocument = { ...customLayout(), canvas: { width: 16384, height: 16384 }, widgets: [{ ...clock(), ...size, x: 0, y: 0 }] };
    const before = structuredClone(original);
    expect(validateLayout(original)).toEqual(original);
    expect(() => importJson(original)).toThrow('Custom widgets must fit within 1280 × 800. Resize this card');
    expect(() => importJson(original.widgets[0])).toThrow('Resize this card');
    expect(() => templateWidget(original.widgets[0])).toThrow('Resize this card');
    expect(original).toEqual(before);
  });

  it('accepts the maximum template size from a portrait canvas', () => {
    const original: LayoutDocument = { ...createSampleLayout(), canvas: { width: 1280, height: 1920 }, widgets: [{ ...clock(), width: 1280, height: 800, x: 0, y: 1120 }] };
    const imported = importJson(original);
    expect(placedTemplate(imported.widgets[0])).toMatchObject({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it('imports 64 cards, refuses 65 even if identical, and keeps a full collection unchanged on merge failure', () => {
    const original: LayoutDocument = { ...createSampleLayout(), widgets: Array.from({ length: MAX_CUSTOM_WIDGETS }, (_, i) => ({ ...textCard('identical'), id: `card-${i}` })) };
    const imported = importJson(original), before = structuredClone(original);
    expect(imported.widgets).toHaveLength(64);
    expect(() => importJson({ ...original, widgets: [...original.widgets, { ...textCard('identical'), id: 'card-65' }] })).toThrow('Import at most 64 cards at a time');
    const importedBefore = structuredClone(imported);
    expect(() => mergeCustomWidgets(imported, sample())).toThrow('at most 64 widgets');
    expect(original).toEqual(before);
    expect(imported).toEqual(importedBefore);
  });

  it('allows 1 MB layout input, counts UTF-8 bytes, and retains the 256 KB widget-file input cap', () => {
    const layout = JSON.stringify(customLayout()), bytes = Buffer.byteLength(layout);
    expect(parseWidgetImport(layout + ' '.repeat(MAX_WIDGET_IMPORT_BYTES - bytes))).toEqual(importJson(customLayout()));
    expect(() => parseWidgetImport(layout + ' '.repeat(MAX_WIDGET_IMPORT_BYTES - bytes + 1))).toThrow('at most 1 MB');
    const unicode = { ...customLayout(), name: '🌕'.repeat(MAX_WIDGET_IMPORT_BYTES / 4) };
    const encoded = JSON.stringify(unicode);
    expect(encoded.length).toBeLessThan(MAX_WIDGET_IMPORT_BYTES);
    expect(() => parseWidgetImport(encoded)).toThrow('at most 1 MB');
    const pack = JSON.stringify(sample()), packBytes = Buffer.byteLength(pack);
    expect(parseWidgetImport(pack + ' '.repeat(MAX_CUSTOM_BYTES - packBytes))).toEqual(sample());
    expect(() => parseWidgetImport(pack + ' '.repeat(MAX_CUSTOM_BYTES - packBytes + 1))).toThrow('at most 256 KB');
    expect(() => parseCustomWidgets(layout + ' '.repeat(MAX_CUSTOM_BYTES))).toThrow('smaller than 256 KB');
  });

  it('enforces the final serialized pack size after extracting a valid layout', () => {
    const empty = { ...createSampleLayout(), widgets: [textCard('')] };
    const overhead = Buffer.byteLength(serializeCustomWidgets(importJson(empty)));
    const exact = { ...empty, widgets: [textCard('a'.repeat(MAX_CUSTOM_BYTES - overhead))] };
    const imported = importJson(exact);
    expect(Buffer.byteLength(serializeCustomWidgets(imported))).toBe(MAX_CUSTOM_BYTES);
    const oversized = { ...empty, widgets: [textCard('a'.repeat(MAX_CUSTOM_BYTES - overhead + 1))] };
    const before = structuredClone(oversized);
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(MAX_WIDGET_IMPORT_BYTES);
    expect(() => importJson(oversized)).toThrow('Split the import into smaller files or shorten card text');
    expect(oversized).toEqual(before);
    // Multibyte card content must obey the output cap too.
    expect(() => importJson({ ...empty, widgets: [textCard('🌕'.repeat(MAX_CUSTOM_BYTES / 4))] })).toThrow('256 KB limit');
  });

  it('refuses a merge that exceeds the byte cap and preserves both valid packs', () => {
    const current = importJson({ ...createSampleLayout(), widgets: [textCard('a'.repeat(MAX_CUSTOM_BYTES / 2))] });
    const imported = importJson({ ...createSampleLayout(), widgets: [textCard('b'.repeat(MAX_CUSTOM_BYTES / 2))] });
    const beforeCurrent = structuredClone(current), beforeImported = structuredClone(imported);
    expect(() => mergeCustomWidgets(current, imported)).toThrow('256 KB limit');
    expect(current).toEqual(beforeCurrent);
    expect(imported).toEqual(beforeImported);
  });
});
