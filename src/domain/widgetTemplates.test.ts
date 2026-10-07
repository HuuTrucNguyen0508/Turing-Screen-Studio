import { describe, expect, it } from 'vitest';
import { createSampleLayout } from './layout';
import { mergeCustomWidgets, parseCustomWidgets, placedTemplate, serializeCustomWidgets, templateWidget, validateCustomWidgets } from './widgetTemplates';

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
