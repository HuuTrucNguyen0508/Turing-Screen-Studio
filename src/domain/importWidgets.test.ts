import { expect, it } from 'vitest';
import { createSampleLayout } from './layout';
import { parseDraftWidgetImport } from './importWidgets';

it('imports a large standalone draft card without imposing the reusable panel-template limit', () => {
  const widget = { type: 'clock', width: 1500, height: 900, settings: { label: 'Large clock', time: '10:24', date: 'Today', format: '24h', showDate: true } };
  expect(parseDraftWidgetImport(JSON.stringify(widget))[0]).toMatchObject({ ...widget, x: 0, y: 0 });
  expect(() => parseDraftWidgetImport(JSON.stringify({ ...widget, x: 0 }))).toThrow();
  expect(() => parseDraftWidgetImport(JSON.stringify({ ...widget, extra: true }))).toThrow();
});
it('preserves full layout coordinates and settings and rejects arbitrary JSON', () => {
  const layout = createSampleLayout();
  expect(parseDraftWidgetImport(JSON.stringify(layout))).toEqual(layout.widgets);
  expect(() => parseDraftWidgetImport('{"command":"exec"}')).toThrow();
  expect(() => parseDraftWidgetImport('[]')).toThrow('Studio');
});
