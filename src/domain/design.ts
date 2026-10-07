import type { ClockWidget, LayoutDocument, Widget } from './layout';

export const designAligns = ['start', 'center', 'end'] as const;
export const designColors = ['text', 'muted', 'primary', 'secondary'] as const;
export interface ElementDesign {
  hidden?: boolean;
  align?: typeof designAligns[number];
  dx?: number;
  dy?: number;
  size?: number;
  color?: typeof designColors[number];
}
export interface WidgetDesign {
  padding?: number;
  elements?: Partial<Record<string, ElementDesign>>;
}
export interface ResolvedElement {
  id: string;
  name: string;
  x: number;
  y: number;
  size: number;
  color: typeof designColors[number];
  align: typeof designAligns[number];
  hidden: boolean;
  text: string;
  family: 'mono' | 'sans';
  suffix?: string;
  suffixSize?: number;
  gap?: number;
}
const elementProps = ['hidden', 'align', 'dx', 'dy', 'size', 'color'] as const;
export interface ElementSpec {
  id: string;
  name: string;
  props: readonly (keyof ElementDesign)[];
  defaults: (widget: ClockWidget) => Omit<ResolvedElement, 'id' | 'name' | 'x'>;
}

/** Formatting lives here so layout validation never imports the widget catalog. */
export function formatClockTime(time: string, format: '24h' | '12h'): string {
  const match = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(time);
  if (!match) return time;
  let hour = Number(match[1]);
  if (/\bPM\b/i.test(time) && hour < 12) hour += 12;
  else if (/\bAM\b/i.test(time) && hour === 12) hour = 0;
  return format === '24h' ? `${String(hour).padStart(2, '0')}:${match[2]}` : `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? 'PM' : 'AM'}`;
}

const clockSpecs: readonly ElementSpec[] = [
  { id: 'label', name: 'Label', props: elementProps, defaults: (widget) => ({
    align: 'start', y: widget.height < 184 ? 22 : 39,
    size: widget.height < 184 ? 13 : 15, color: 'muted', family: 'sans',
    hidden: widget.height < 184 || !widget.settings.label, text: widget.settings.label,
  }) },
  { id: 'time', name: 'Time', props: elementProps, defaults: (widget) => {
    const compact = widget.height < 184;
    const parts = formatClockTime(widget.settings.time, widget.settings.format).split(' ');
    return { align: 'start', y: compact ? Math.floor(widget.height / 2) + (widget.settings.showDate ? -1 : 10) : 110,
      size: compact ? 40 : 72, color: compact ? 'text' : 'primary', family: 'mono', hidden: false,
      text: parts[0], ...(parts.length > 1 ? { suffix: parts.slice(1).join(' '), suffixSize: compact ? 16 : 23, gap: compact ? 6 : 9 } : {}),
    };
  } },
  { id: 'date', name: 'Date', props: elementProps, defaults: (widget) => ({
    align: 'start', y: widget.height < 184 ? Math.floor(widget.height / 2) + 26 : widget.height - 29,
    size: widget.height < 184 ? 14 : 15, color: 'muted', family: 'sans',
    hidden: !widget.settings.showDate, text: widget.settings.date,
  }) },
];
export const ELEMENT_SPECS: Readonly<Partial<Record<Widget['type'], readonly ElementSpec[]>>> = { clock: clockSpecs };
export function elementSpecs(widget: Widget): readonly ElementSpec[] {
  return ELEMENT_SPECS[widget.type] ?? [];
}

function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
function object(input: unknown, path: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(path, 'expected a plain JSON object');
  if (!Reflect.ownKeys(input).length) fail(path, 'remove the empty object');
  return input as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string, message = 'unexpected field') {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail(`${path}.${String(key)}`, message);
  }
}
function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(path, 'expected a safe integer');
  if (value < min || value > max) fail(path, `must be between ${min} and ${max}`);
  return value === 0 ? 0 : value;
}

/** Standalone validation returns a detached design in shared canonical order. */
export function validateWidgetDesign(input: unknown, type: string, path: string): WidgetDesign {
  if (type !== 'clock') fail(path, `${type} cards have no editable elements`);
  const value = object(input, path);
  keys(value, ['padding', 'elements'], path);
  const design: WidgetDesign = {};
  if (Object.hasOwn(value, 'padding')) design.padding = integer(value.padding, `${path}.padding`, 0, 64);
  if (Object.hasOwn(value, 'elements')) {
    const elements = object(value.elements, `${path}.elements`);
    keys(elements, clockSpecs.map((spec) => spec.id), `${path}.elements`, 'unknown clock element; expected label, time, date');
    design.elements = {};
    for (const spec of clockSpecs) {
      if (!Object.hasOwn(elements, spec.id)) continue;
      const elementPath = `${path}.elements.${spec.id}`;
      const raw = object(elements[spec.id], elementPath);
      keys(raw, spec.props, elementPath, `${spec.id} supports ${spec.props.join(', ')}`);
      const element: ElementDesign = {};
      for (const prop of elementProps) {
        if (!Object.hasOwn(raw, prop)) continue;
        const fieldPath = `${elementPath}.${prop}`;
        if (prop === 'hidden') {
          if (typeof raw[prop] !== 'boolean') fail(fieldPath, 'expected a boolean');
          element.hidden = raw[prop];
        } else if (prop === 'align') {
          if (!designAligns.includes(raw[prop] as ElementDesign['align'] & string)) fail(fieldPath, `expected ${designAligns.join(', ')}`);
          element.align = raw[prop] as ElementDesign['align'];
        } else if (prop === 'color') {
          if (!designColors.includes(raw[prop] as ElementDesign['color'] & string)) fail(fieldPath, `expected ${designColors.join(', ')}`);
          element.color = raw[prop] as ElementDesign['color'];
        } else element[prop] = integer(raw[prop], fieldPath, prop === 'size' ? 8 : -512, prop === 'size' ? 160 : 512);
      }
      design.elements[spec.id] = element;
    }
  }
  return design;
}

export function resolveElements(widget: Widget): ResolvedElement[] {
  if (widget.type !== 'clock') return [];
  const padding = widget.design?.padding ?? 29;
  return clockSpecs.map((spec) => {
    const defaults = spec.defaults(widget);
    const design = widget.design?.elements?.[spec.id] ?? {};
    const align = design.align ?? defaults.align;
    const size = design.size ?? defaults.size;
    return { ...defaults, id: spec.id, name: spec.name, align, size,
      x: (align === 'center' ? widget.width / 2 : align === 'end' ? widget.width - padding : padding) + (design.dx ?? 0),
      y: defaults.y + (design.dy ?? 0), color: design.color ?? defaults.color,
      hidden: (spec.id === 'date' && !widget.settings.showDate) || (design.hidden ?? defaults.hidden),
      ...(defaults.suffix === undefined ? {} : { suffixSize: Math.round(size * (widget.height < 184 ? .4 : 23 / 72)) }),
    };
  });
}

export type WidgetDesignPatch = { padding: number | null } | { element: string; set: Partial<ElementDesign> }
  | { element: string; reset: true } | { reset: true };

export function updateWidgetDesign(doc: LayoutDocument, id: string, patch: WidgetDesignPatch): LayoutDocument {
  const index = doc.widgets.findIndex((widget) => widget.id === id);
  const widget = doc.widgets[index];
  if (!widget) fail('$.widgets', `widget ID "${id}" was not found`);
  const path = `$.widgets[${index}].design`;
  if (widget.type !== 'clock') fail(path, `${widget.type} cards have no editable elements`);
  const next: WidgetDesign = { ...widget.design, ...(widget.design?.elements ? { elements: { ...widget.design.elements } } : {}) };
  if ('element' in patch) {
    if (!clockSpecs.some((spec) => spec.id === patch.element)) fail(`${path}.elements.${patch.element}`, 'unknown clock element; expected label, time, date');
    if ('reset' in patch) delete next.elements?.[patch.element];
    else {
      const element = { ...next.elements?.[patch.element], ...patch.set };
      if (Reflect.ownKeys(element).length) next.elements = { ...next.elements, [patch.element]: element };
    }
  } else if ('padding' in patch) {
    if (patch.padding === null) delete next.padding;
    else next.padding = patch.padding;
  } else {
    delete next.padding;
    delete next.elements;
  }
  if (next.elements && !Object.keys(next.elements).length) delete next.elements;
  const design = Object.keys(next).length ? validateWidgetDesign(next, widget.type, path) : undefined;
  if (JSON.stringify(design) === JSON.stringify(widget.design)) return doc;
  const { design: previousDesign, ...rest } = widget;
  void previousDesign;
  const widgets = doc.widgets.slice();
  widgets[index] = { ...rest, ...(design ? { design } : {}) };
  return { ...doc, widgets };
}
