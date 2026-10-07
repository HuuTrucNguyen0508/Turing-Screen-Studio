import { paletteColorKeys, validateWidgetColors } from './layout';
import type { LayoutDocument, Palette, PaletteColorKey, Widget, WidgetColors } from './layout';

/** Apply saved card overrides to the current saved or live palette. */
export function effectiveWidgetPalette(base: Palette, widget: Widget): Palette {
  return { ...base, ...widget.colors };
}

/** Set a role, or remove its override with null. No-ops retain document identity. */
export function updateWidgetColor(doc: LayoutDocument, id: string, key: PaletteColorKey, color: string | null): LayoutDocument {
  const index = doc.widgets.findIndex((entry) => entry.id === id);
  const widget = doc.widgets[index];
  if (!widget) throw new Error(`$.widgets: widget ID "${id}" was not found`);
  const path = `$.widgets[${index}].colors`;
  if (!paletteColorKeys.includes(key)) throw new Error(`${path}.${String(key)}: unexpected field`);
  const next: WidgetColors = { ...widget.colors };
  if (color === null) delete next[key];
  else next[key] = color;
  const colors = Object.keys(next).length ? validateWidgetColors(next, path) : undefined;
  if (JSON.stringify(colors) === JSON.stringify(widget.colors)) return doc;
  const { colors: previousColors, ...rest } = widget;
  void previousColors;
  const widgets = doc.widgets.slice();
  widgets[index] = { ...rest, ...(colors ? { colors } : {}) };
  return { ...doc, widgets };
}
