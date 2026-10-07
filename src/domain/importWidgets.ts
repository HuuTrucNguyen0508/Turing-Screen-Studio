import { createSampleLayout, parseLayout } from './layout';
import type { Widget } from './layout';
import { parseCustomWidgets, placedTemplate } from './widgetTemplates';

/** Draft imports use layout limits; reusable packs are validated separately. */
export function parseDraftWidgetImport(text: string): Widget[] {
  if (text.length > 1024 * 1024) throw new Error('Choose JSON smaller than 1 MiB.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('Invalid JSON. Choose a Studio layout, widget pack or widget definition.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Choose a Studio layout, widget pack or widget definition.');
  const value = raw as Record<string, unknown>;
  if (['canvas', 'palette', 'paletteMode', 'chrome'].some((key) => Object.hasOwn(value, key))) return parseLayout(text).widgets;
  if (Object.hasOwn(value, 'version') || Object.hasOwn(value, 'widgets')) return parseCustomWidgets(text).widgets.map(placedTemplate);
  let card = value;
  if (Object.hasOwn(value, 'widget')) {
    if (Object.keys(value).length !== 3 || typeof value.id !== 'string' || typeof value.name !== 'string' || !value.name.trim()) throw new Error('A custom widget requires id, name and widget.');
    if (!value.widget || typeof value.widget !== 'object' || Array.isArray(value.widget)) throw new Error('widget must be an object.');
    const template = value.widget as Record<string, unknown>;
    if (['id', 'x', 'y'].some((key) => Object.hasOwn(template, key))) throw new Error('A reusable widget omits its position and ID.');
    card = { ...template, id: value.id, x: 0, y: 0 };
  } else if (!['id', 'x', 'y'].some((key) => Object.hasOwn(card, key))) card = { ...card, id: 'imported-widget', x: 0, y: 0 };
  // The synthetic document enforces all geometry, settings and portable byte limits.
  return parseLayout(JSON.stringify({ ...createSampleLayout(), canvas: { width: 16384, height: 16384 }, widgets: [card] })).widgets;
}
