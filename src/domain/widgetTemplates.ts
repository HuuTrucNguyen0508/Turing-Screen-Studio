import { createSampleLayout, validateLayout } from './layout';
import type { Widget } from './layout';

export const MAX_CUSTOM_WIDGETS = 64;
export const MAX_CUSTOM_BYTES = 256 * 1024;
export const MAX_WIDGET_IMPORT_BYTES = 1024 * 1024;
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
  // Keep copies compatible with the existing browser and Python template store.
  if (widget.width > 1280 || widget.height > 800) {
    throw new Error(`Card "${widget.id}" is ${widget.width} × ${widget.height}. Custom widgets must fit within 1280 × 800. Resize this card before importing or saving it as a custom widget.`);
  }
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
    if (value.widget && typeof value.widget === 'object' && Object.hasOwn(value.widget, 'colors')) fields.push('colors');
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

const SUPPORTED_WIDGET_IMPORTS = 'Supported formats: Studio widget pack, Studio layout, single placed Studio widget, or Studio template JSON. Executable files and other formats are not supported.';

function importedCards(widgets: Widget[]): CustomWidgets {
  if (widgets.length > MAX_CUSTOM_WIDGETS) {
    throw new Error(`This layout has ${widgets.length} cards. Import at most ${MAX_CUSTOM_WIDGETS} cards at a time by splitting it into smaller layouts.`);
  }
  const entries: CustomWidget[] = [];
  for (const widget of widgets) {
    const label = 'label' in widget.settings ? widget.settings.label.trim() : '';
    const base = (label || widget.type).slice(0, 60).trim();
    let name = base, count = 2;
    while (entries.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
      const suffix = ` (${count++})`;
      name = base.slice(0, 60 - suffix.length) + suffix;
    }
    entries.push({ id: uniqueTemplateId(widget.id, entries), name, widget: templateWidget(widget) });
  }
  return validateCustomWidgets({ version: 1, widgets: entries });
}

/** File imports are broader than the strict widget-pack parser used by storage. */
export function parseWidgetImport(text: string): CustomWidgets {
  try {
    const bytes = utf8Size(text);
    if (bytes > MAX_WIDGET_IMPORT_BYTES) throw new Error('Choose a Studio layout file of at most 1 MB, or a widget file of at most 256 KB.');
    let raw: unknown;
    try { raw = JSON.parse(text) as unknown; }
    catch { throw new Error('Invalid JSON. Export a supported Studio JSON file and try again.'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Unsupported widget file.');
    const value = raw as Record<string, unknown>;
    // Choose a validator by shape, then validate the entire input. Never fall
    // back to extracting a valid subset from a malformed document or pack.
    if (['canvas', 'palette', 'paletteMode', 'chrome'].some((key) => Object.hasOwn(value, key))) {
      return importedCards(validateLayout(value).widgets);
    }
    if (bytes > MAX_CUSTOM_BYTES) throw new Error('Choose a widget file of at most 256 KB. Only Studio layouts may be up to 1 MB.');
    if (Object.hasOwn(value, 'version') || Object.hasOwn(value, 'widgets')) return validateCustomWidgets(value);
    if (Object.hasOwn(value, 'widget')) return validateCustomWidgets({ version: 1, widgets: [value] });
    if (Object.hasOwn(value, 'type')) {
      let widget: Record<string, unknown>;
      if (['id', 'x', 'y'].some((key) => Object.hasOwn(value, key))) widget = value;
      else {
        const fields = ['type', 'width', 'height', 'settings'];
        if (Object.hasOwn(value, 'design')) fields.push('design');
        if (Object.hasOwn(value, 'colors')) fields.push('colors');
        widget = { id: 'widget', x: 0, y: 0, ...object(value, fields, '$') };
      }
      // A standalone placement must be valid at its original coordinates on
      // a legal Studio canvas before its position is removed.
      const layout = { ...createSampleLayout(), canvas: { width: 16384, height: 16384 }, widgets: [widget] };
      return importedCards(validateLayout(layout).widgets);
    }
    throw new Error('Unsupported widget file.');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const remedy = reason === 'Custom widgets exceed the 256 KB limit.'
      ? ' Split the import into smaller files or shorten card text.' : '';
    throw new Error(`${reason}${remedy} ${SUPPORTED_WIDGET_IMPORTS}`);
  }
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
