import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { elementSpecs, resolveElements, updateWidgetDesign, validateWidgetDesign } from './design';
import type { ClockWidget, LayoutDocument } from './layout';
import { createSampleLayout, moveWidget, pointerDeltaToDocument, serializeLayout, updateGeometry, validateLayout } from './layout';
import { updateWidgetSettings } from './widgets';

const clock = (): ClockWidget => ({ id: 'clock', type: 'clock', x: 946, y: 40, width: 270, height: 80,
  settings: { label: 'Local time', time: '14:32', date: 'Tuesday, 6 October', format: '24h', showDate: true, source: 'clock' } });
const document = (): LayoutDocument => ({ ...createSampleLayout(), widgets: [clock()] });

describe('clock element placement', () => {
  it('resolves measured compact baselines, all horizontal anchors, and odd widths', () => {
    const widget = clock();
    expect(elementSpecs(widget).map(({ id, name }) => [id, name])).toEqual([['label', 'Label'], ['time', 'Time'], ['date', 'Date']]);
    expect(resolveElements(widget).map(({ x, y, size, hidden }) => ({ x, y, size, hidden }))).toEqual([
      { x: 29, y: 22, size: 13, hidden: true }, { x: 29, y: 39, size: 40, hidden: false }, { x: 29, y: 66, size: 14, hidden: false },
    ]);
    for (const [align, x] of [['start', 29], ['center', 135], ['end', 241]] as const) {
      widget.design = { elements: { time: { align }, date: { align } } };
      expect(resolveElements(widget).slice(1).map((element) => [element.x, element.y, element.align])).toEqual([[x, 39, align], [x, 66, align]]);
    }
    widget.design = { padding: 40, elements: { time: { align: 'end', dx: -4, dy: 12, size: 80, color: 'secondary' } } };
    expect(resolveElements(widget)[1]).toMatchObject({ x: 226, y: 51, size: 80, color: 'secondary' });
    widget.width = 271;
    widget.design = { elements: { time: { align: 'center' } } };
    expect(resolveElements(widget)[1].x).toBe(135.5);
  });

  it('keeps content visibility authoritative and scales composite suffixes around a fixed baseline', () => {
    const widget = clock();
    widget.settings.format = '12h';
    widget.settings.showDate = false;
    widget.design = { elements: { label: { hidden: false }, time: { size: 41 }, date: { hidden: false } } };
    expect(resolveElements(widget)[0].hidden).toBe(false);
    expect(resolveElements(widget)[1]).toMatchObject({ text: '2:32', suffix: 'PM', suffixSize: 16, gap: 6, y: 50, size: 41 });
    expect(resolveElements(widget)[2].hidden).toBe(true);
    widget.height = 184;
    widget.settings.showDate = true;
    widget.design = { padding: 29 };
    expect(resolveElements(widget)[1]).toMatchObject({ size: 72, suffixSize: 23, gap: 9, y: 110, color: 'primary' });
    expect(resolveElements(widget)[0]).toMatchObject({ size: 15, y: 39, hidden: false });
    expect(resolveElements(widget)[2].y).toBe(155);
    expect(resolveElements(createSampleLayout().widgets[0])).toEqual([]);
  });
});

describe('design editing and cross-language contract', () => {
  it('makes each effective edit a detached document, preserves explicit defaults and prunes resets', () => {
    const original = document();
    expect(updateWidgetDesign(original, 'clock', { reset: true })).toBe(original);
    expect(updateWidgetDesign(original, 'clock', { element: 'time', set: {} })).toBe(original);
    const centered = updateWidgetDesign(original, 'clock', { element: 'time', set: { align: 'center' } });
    expect(original.widgets[0].design).toBeUndefined();
    expect(centered.widgets[0].settings).toBe(original.widgets[0].settings);
    expect(updateWidgetDesign(centered, 'clock', { element: 'time', set: { align: 'center' } })).toBe(centered);
    const padded = updateWidgetDesign(centered, 'clock', { padding: 29 });
    expect(padded.widgets[0].design?.padding).toBe(29);
    const resetTime = updateWidgetDesign(padded, 'clock', { element: 'time', reset: true });
    expect(resetTime.widgets[0].design).toEqual({ padding: 29 });
    const resetPadding = updateWidgetDesign(resetTime, 'clock', { padding: null });
    expect(Object.hasOwn(resetPadding.widgets[0], 'design')).toBe(false);
    expect(serializeLayout(resetPadding)).toBe(serializeLayout(original));
    expect(() => updateWidgetDesign(original, 'clock', { element: 'unknown', set: { hidden: true } })).toThrow('$.widgets[0].design.elements.unknown');
  });

  it('retains overrides through scaled pointer movement, resize, source and clock content edits', () => {
    const designed = updateWidgetDesign(document(), 'clock', { element: 'time', set: { align: 'center', dx: 512 } });
    const before = designed.widgets[0].design;
    const delta = pointerDeltaToDocument(-20, 10, .5);
    const moved = moveWidget(designed, 'clock', delta.x, delta.y);
    const resized = updateGeometry(moved, 'clock', { width: 130, height: 200 });
    const content = updateWidgetSettings(resized, 'clock', { source: 'sample', format: '12h', showDate: false });
    expect(content.widgets[0].design).toEqual(before);
    expect(serializeLayout(content)).toContain('"dx": 512');
    expect(designed.widgets[0].design).toEqual(before);
  });

  it('matches Python placements and canonical bytes over compact, full and fractional center anchors', () => {
    const cases: ClockWidget[] = [];
    for (const height of [80, 183, 184, 270]) for (const width of [270, 271]) for (const format of ['24h', '12h'] as const) {
      cases.push({ ...clock(), x: 0, width, height, settings: { ...clock().settings, format },
        design: { elements: { date: { dy: -12, color: 'secondary' }, time: { size: 81, dx: 4, align: 'center' }, label: { hidden: false } }, padding: 40 } });
    }
    const script = 'import json,sys\nfrom turzx_studio.design import resolve_elements\nfrom turzx_studio.layout import serialize_layout\nv=json.load(sys.stdin)\nprint(json.dumps({"resolved":[resolve_elements(w) for w in v["widgets"]],"bytes":serialize_layout(v)},ensure_ascii=False))';
    const input = { ...document(), widgets: cases.map((widget, i) => ({ ...widget, id: `clock-${i}` })) };
    const python = JSON.parse(execFileSync('python3', ['-c', script], {
      input: JSON.stringify(input), env: { ...process.env, PYTHONPATH: 'runtime' }, encoding: 'utf8',
    }));
    expect(python.resolved).toEqual(input.widgets.map(resolveElements));
    expect(python.bytes).toBe(serializeLayout(input));
    expect(validateLayout(input).widgets[0].design).not.toBe(input.widgets[0].design);
  });

  const invalid: [unknown, string][] = [
    [{}, ': remove the empty object'], [{ elements: {} }, '.elements: remove the empty object'],
    [{ elements: { time: {} } }, '.elements.time: remove the empty object'],
    [{ x: 0 }, '.x: unexpected field'], [{ elements: { weather: { hidden: true } } }, '.elements.weather: unknown clock element; expected label, time, date'],
    [{ elements: { time: { anchor: 'center' } } }, '.elements.time.anchor: time supports hidden, align, dx, dy, size, color'],
    [{ padding: 65 }, '.padding: must be between 0 and 64'],
    [{ elements: { time: { dx: 1.5 } } }, '.elements.time.dx: expected a safe integer'],
    [{ elements: { time: { dy: 600 } } }, '.elements.time.dy: must be between -512 and 512'],
    [{ elements: { time: { size: 7 } } }, '.elements.time.size: must be between 8 and 160'],
    [{ elements: { time: { hidden: 1 } } }, '.elements.time.hidden: expected a boolean'],
    [{ elements: { time: { align: 'middle' } } }, '.elements.time.align: expected start, center, end'],
    [{ elements: { time: { color: '#ffffff' } } }, '.elements.time.color: expected text, muted, primary, secondary'],
    [{ elements: { time: { dx: null } } }, '.elements.time.dx: expected a safe integer'],
  ];
  it.each(invalid)('rejects invalid overrides at their precise path: %j', (input, error) => {
    expect(() => validateWidgetDesign(input, 'clock', '$.widgets[0].design')).toThrow(`$.widgets[0].design${error}`);
  });

  it('matches Python validation errors and rejects all types outside phase A', () => {
    const script = 'import json,sys\nfrom turzx_studio.design import validate_widget_design\nresult=[]\nfor v in json.load(sys.stdin):\n try: validate_widget_design(v,"clock","$.widgets[0].design")\n except ValueError as e: result.append(str(e))\nprint(json.dumps(result))';
    const python = JSON.parse(execFileSync('python3', ['-c', script], {
      input: JSON.stringify(invalid.map(([input]) => input)), env: { ...process.env, PYTHONPATH: 'runtime' }, encoding: 'utf8',
    }));
    expect(python).toEqual(invalid.map(([, error]) => `$.widgets[0].design${error}`));
    for (const type of ['metric', 'weather', 'gauge', 'text', 'storage']) {
      expect(() => validateWidgetDesign({ padding: 29 }, type, '$.widgets[0].design')).toThrow(`${type} cards have no editable elements`);
    }
  });
});
