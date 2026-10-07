export { formatClockTime } from './design';
import sharedCatalog from '../../public/widget-catalog.json';
import { createSampleLayout, metricSources, validateLayout } from './layout';
import type { Geometry, LayoutDocument, Widget } from './layout';
import { trendSources } from './trend';

export const sourceLabels: Record<string, string> = {
  sample: 'Sample values', cpu: 'CPU load', gpu: 'GPU load', memory: 'Memory used',
  disk: 'Disk used', 'network-down': 'Network download', 'network-up': 'Network upload',
  'cpu-temperature': 'CPU temperature', 'gpu-temperature': 'GPU temperature',
  weather: 'Local weather', clock: 'Panel clock',
  'codex-tokens': 'Codex tokens today', 'codex-cost': 'Codex API cost estimate',
  'codex-weekly': 'Codex Pro weekly limit', 'codex-reset': 'Codex weekly reset', 'codex-models': 'Codex models today',
  'claude-tokens': 'Claude tokens today', 'claude-cost': 'Claude API cost estimate',
  'claude-session': 'Claude 5-hour limit', 'claude-weekly': 'Claude weekly limit',
  'claude-reset': 'Claude reset', 'claude-models': 'Claude models today', storage: 'Root storage used/free', 'mounted-storage': 'All mounted storage',
};

export function widgetSources(widget: Widget): readonly string[] {
  if (widget.type === 'storage') return ['sample', 'mounted-storage'];
  if (widget.type === 'text') return [];
  if (widget.type === 'clock') return ['sample', 'clock'];
  if (widget.type === 'weather') return ['sample', 'weather'];
  if (widget.type === 'metric' && widget.settings.trend) return ['sample', ...trendSources];
  return metricSources;
}

export interface WidgetTemplate {
  id: string;
  name: string;
  group: string;
  family: string;
  variant: string;
  description: string;
  widget: Widget;
}

export interface WidgetGroup { id: string; name: string }

export function parseWidgetCatalog(input: unknown): { entries: WidgetTemplate[]; groups: WidgetGroup[] } {
  if (!input || typeof input !== 'object' || !('widgets' in input) || !Array.isArray(input.widgets)
    || !('groups' in input) || !Array.isArray(input.groups) || !('canvas' in input) || !('version' in input)) {
    throw new Error('Expected a widget catalog with groups and a canvas.');
  }
  const groupIds = new Set<string>();
  const groups = input.groups.map((entry: unknown) => {
    const value = catalogMetadata(entry, ['id', 'name']);
    if (groupIds.has(value.id)) throw new Error(`Duplicate widget group "${value.id}".`);
    groupIds.add(value.id);
    return { id: value.id, name: value.name };
  });
  const metadata = input.widgets.map((entry: unknown) => {
    const value = catalogMetadata(entry, ['id', 'name', 'group', 'family', 'variant', 'description']);
    if (!groupIds.has(value.group)) throw new Error(`Unknown widget group "${value.group}".`);
    return value;
  });
  // The layout validator checks IDs, integer geometry, sources and content, and copies settings.
  const document = validateLayout({
    ...createSampleLayout(), version: input.version, canvas: input.canvas,
    widgets: input.widgets.map((entry: Record<string, unknown>) => ({
      id: entry.id, type: entry.type, x: 0, y: 0, width: entry.width, height: entry.height, settings: entry.settings,
      ...(Object.hasOwn(entry, 'design') ? { design: entry.design } : {}),
    })),
  });
  return {
    groups,
    entries: document.widgets.map((widget, index) => {
      const value = metadata[index];
      return { id: value.id, name: value.name, group: value.group, family: value.family,
        variant: value.variant, description: value.description, widget };
    }),
  };
}

function catalogMetadata(input: unknown, fields: readonly string[]): Record<string, string> {
  if (!input || typeof input !== 'object') throw new Error('Invalid widget catalog metadata.');
  const value = input as Record<string, unknown>;
  for (const field of fields) {
    if (typeof value[field] !== 'string' || !value[field].trim()) throw new Error(`Invalid widget catalog ${field}.`);
  }
  return value as Record<string, string>;
}

const catalog = parseWidgetCatalog(sharedCatalog);
export const widgetCatalog: readonly WidgetTemplate[] = catalog.entries;
export const widgetGroups: readonly WidgetGroup[] = catalog.groups;

function nextId(doc: LayoutDocument, base: string): string {
  const ids = new Set(doc.widgets.map((widget) => widget.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

function placement(doc: LayoutDocument, template: Geometry): Geometry {
  const width = Math.min(template.width, doc.canvas.width);
  const height = Math.min(template.height, doc.canvas.height);
  const maxX = doc.canvas.width - width, maxY = doc.canvas.height - height;
  const startX = Math.min(64, maxX), startY = Math.min(160, maxY);
  const xs = new Set([startX, 0, maxX]);
  const ys = new Set([startY, 0, maxY]);
  for (const widget of doc.widgets) {
    for (const x of [widget.x + widget.width + 24, widget.x - width - 24]) if (x >= 0 && x <= maxX) xs.add(x);
    for (const y of [widget.y + widget.height + 24, widget.y - height - 24]) if (y >= 0 && y <= maxY) ys.add(y);
  }
  const order = (start: number) => (a: number, b: number) => (a < start ? 1 : 0) - (b < start ? 1 : 0) || a - b;
  let attempts = 0;
  for (const y of [...ys].sort(order(startY))) {
    for (const x of [...xs].sort(order(startX))) {
      if (++attempts > 2048) return { x: Math.min(startX + 24, maxX), y: Math.min(startY + 24, maxY), width, height };
      if (doc.widgets.every((widget) => x + width <= widget.x || x >= widget.x + widget.width || y + height <= widget.y || y >= widget.y + widget.height)) {
        return { x, y, width, height };
      }
    }
  }
  // Full canvases still allow additions. Keep the overlap visible and in bounds.
  return { x: Math.min(startX + 24, maxX), y: Math.min(startY + 24, maxY), width, height };
}

function append(doc: LayoutDocument, template: Widget, base: string): LayoutDocument {
  const widget = { ...template, ...placement(doc, template), id: nextId(doc, base), settings: { ...template.settings } };
  return validateLayout({ ...doc, widgets: [...doc.widgets, widget] });
}

export function addWidget(doc: LayoutDocument, presetId: string): LayoutDocument {
  const preset = widgetCatalog.find((entry) => entry.id === presetId);
  if (!preset) throw new Error('Choose a widget from the catalog.');
  return append(doc, preset.widget, preset.id);
}

/** Place a detached custom template through the same bounded catalog path. */
export function addWidgetTemplate(doc: LayoutDocument, widget: Omit<Widget, 'id' | 'x' | 'y'>, baseId: string): LayoutDocument {
  return append(doc, { ...widget, id: baseId, x: 0, y: 0 } as Widget, baseId);
}

export function duplicateWidget(doc: LayoutDocument, id: string): LayoutDocument {
  const current = doc.widgets.find((widget) => widget.id === id);
  if (!current) throw new Error(`Widget "${id}" was not found.`);
  return append(doc, current, current.id);
}

export function removeWidget(doc: LayoutDocument, id: string): LayoutDocument {
  return { ...doc, widgets: doc.widgets.filter((widget) => widget.id !== id) };
}

export function updateWidgetSettings(doc: LayoutDocument, id: string, patch: Record<string, unknown>): LayoutDocument {
  if (!doc.widgets.some((widget) => widget.id === id)) throw new Error(`Widget "${id}" was not found.`);
  return validateLayout({ ...doc, widgets: doc.widgets.map((widget) => {
    if (widget.id !== id) return widget;
    const settings: Record<string, unknown> = { ...widget.settings, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete settings[key];
    return { ...widget, settings };
  }) });
}


export function gaugeFraction(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  if (Number.isFinite(max - min)) return (value - min) / (max - min);
  const scale = Math.max(Math.abs(min), Math.abs(max), 1);
  return Math.min(1, Math.max(0, (value / scale - min / scale) / (max / scale - min / scale)));
}

// New instruments share bounded document coordinates; the legacy arc keeps its geometry.
export function instrumentGeometry(width: number, height: number) {
  const padding = Math.min(29, Math.floor(width / 6));
  const available = Math.max(1, width - 2 * padding);
  const radius = Math.floor(Math.min((available - 10) / 2, (height - 128) / 2));
  const meterY = Math.floor(63 + Math.max(0, height - 127) * .58);
  const size = Math.max(12, Math.min(58, Math.floor(available / 4)));
  return { padding, available, radius, cx: width / 2, cy: 63 + radius,
    meterY, size, showShape: width >= 120 && height >= 160 };
}

export function gaugeGeometry(width: number, height: number) {
  const radius = Math.floor(Math.min((width - 68) / 2, (height - 150) / 1.5));
  return { radius, cx: width / 2, cy: 63 + radius, size: Math.max(24, Math.min(58, Math.floor(radius * .48))) };
}

export function formatGaugeNumber(value: number): string {
  // Large readings avoid multiplication overflow; normal instrument readings use one decimal.
  if (Math.abs(value) > 1e14) return String(value);
  return String(Math.floor(value * 10 + .5) / 10);
}

export interface LayoutPreset { id: string; name: string; description: string; document: LayoutDocument }

export function parseLayoutPresets(input: unknown): LayoutPreset[] {
  if (!input || typeof input !== 'object' || !('presets' in input) || !Array.isArray(input.presets)) throw new Error('Expected a layout preset catalog.');
  const ids = new Set<string>();
  return input.presets.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string' || !entry.id.trim()
      || !('name' in entry) || typeof entry.name !== 'string' || !entry.name.trim()
      || !('description' in entry) || typeof entry.description !== 'string' || !('document' in entry)) throw new Error('Invalid layout preset.');
    if (ids.has(entry.id)) throw new Error(`Duplicate layout preset "${entry.id}".`);
    ids.add(entry.id);
    return { id: entry.id, name: entry.name, description: entry.description, document: validateLayout(entry.document) };
  });
}
