import { createSampleLayout, validateLayout } from './layout';
import type { Widget } from './layout';

export const MAX_CUSTOM_WIDGETS = 64;
export const MAX_CUSTOM_BYTES = 256 * 1024;
export type TemplateWidget = Omit<Widget, 'id' | 'x' | 'y'>;
export type CustomWidget = { id: string; name: string; widget: TemplateWidget };
export type CustomWidgets = { version: 1; widgets: CustomWidget[] };

function object(raw: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error(`${path}: expected an object.`);
  const value = raw as Record<string, unknown>;
  if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error(`${path}: expected ${keys.join(', ')}.`);
  return value;
}

function utf8Size(text: string): number {
  let bytes = 0;
  for (const char of text) { const code = char.codePointAt(0)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
  return bytes;
}

export function templateWidget(widget: Widget): TemplateWidget {
  const { id: _id, x: _x, y: _y, ...copy } = validateLayout({ ...createSampleLayout(), widgets: [{ ...widget, x: 0, y: 0 }] }).widgets[0];
  return copy;
}

export function placedTemplate(template: CustomWidget): Widget {
  return validateLayout({ ...createSampleLayout(), widgets: [{ id: template.id, x: 0, y: 0, ...template.widget }] }).widgets[0];
}

export function validateCustomWidgets(raw: unknown): CustomWidgets {
  const root = object(raw, ['version', 'widgets'], '$');
  if (root.version !== 1 || !Array.isArray(root.widgets) || root.widgets.length > MAX_CUSTOM_WIDGETS) throw new Error('Custom widgets require version 1 and at most 64 widgets.');
  const ids = new Set<string>(), names = new Set<string>();
  const widgets = root.widgets.map((raw, index): CustomWidget => {
    const path = `$.widgets[${index}]`;
    const value = object(raw, ['id', 'name', 'widget'], path);
    if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(value.id) || ids.has(value.id)) throw new Error(`${path}.id: invalid or duplicate ID.`);
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 60 || names.has(value.name.trim().toLowerCase())) throw new Error(`${path}.name: use a unique name of 1 to 60 characters.`);
    ids.add(value.id); names.add(value.name.trim().toLowerCase());
    const fields = ['type', 'width', 'height', 'settings'];
    if (value.widget && typeof value.widget === 'object' && Object.hasOwn(value.widget, 'design')) fields.push('design');
    const widget = object(value.widget, fields, `${path}.widget`);
    const checked = validateLayout({ ...createSampleLayout(), widgets: [{ id: value.id, x: 0, y: 0, ...widget }] }).widgets[0];
    return { id: value.id, name: value.name.trim(), widget: templateWidget(checked) };
  });
  const result: CustomWidgets = { version: 1, widgets };
  if (utf8Size(JSON.stringify(result, null, 2) + '\n') > MAX_CUSTOM_BYTES) throw new Error('Custom widgets exceed the 256 KB limit.');
  return result;
}

export function serializeCustomWidgets(raw: CustomWidgets): string { return JSON.stringify(validateCustomWidgets(raw), null, 2) + '\n'; }
export function parseCustomWidgets(text: string): CustomWidgets {
  if (utf8Size(text) > MAX_CUSTOM_BYTES) throw new Error('Choose a widget file smaller than 256 KB.');
  return validateCustomWidgets(JSON.parse(text));
}

export function uniqueTemplateId(base: string, widgets: CustomWidget[]): string {
  const safe = base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 42) || 'widget';
  let id = safe, count = 2;
  while (widgets.some((widget) => widget.id === id)) id = `${safe}-${count++}`;
  return id;
}

export function mergeCustomWidgets(current: CustomWidgets, imported: CustomWidgets): { document: CustomWidgets; added: number; skipped: number } {
  const widgets = [...validateCustomWidgets(current).widgets];
  let added = 0, skipped = 0;
  for (const entry of validateCustomWidgets(imported).widgets) {
    if (widgets.some((item) => JSON.stringify(item.widget) === JSON.stringify(entry.widget))) { skipped++; continue; }
    let name = entry.name, count = 1;
    while (widgets.some((item) => item.name.toLowerCase() === name.toLowerCase())) { const suffix = count++ === 1 ? ' (imported)' : ` (imported ${count - 1})`; name = entry.name.slice(0, 60 - suffix.length) + suffix; }
    widgets.push({ ...entry, id: uniqueTemplateId(entry.id, widgets), name }); added++;
  }
  return { document: validateCustomWidgets({ version: 1, widgets }), added, skipped };
}
