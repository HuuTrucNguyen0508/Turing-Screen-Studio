export interface Palette {
  name: string;
  background: string;
  surface: string;
  surfaceRaised: string;
  text: string;
  muted: string;
  primary: string;
  secondary: string;
  outline: string;
}

export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MetricWidget extends Geometry {
  id: string;
  type: 'metric';
  settings: { label: string; value: string; unit: string; detail: string; source?: MetricSource };
}

export const metricSources = ['sample', 'cpu', 'gpu', 'memory', 'disk', 'network-down', 'network-up'] as const;
export type MetricSource = typeof metricSources[number];

export interface WeatherWidget extends Geometry {
  id: string;
  type: 'weather';
  settings: {
    location: string;
    temperature: string;
    unit: string;
    condition: string;
    high: string;
    low: string;
    source?: 'sample' | 'weather';
  };
}

export type Widget = MetricWidget | WeatherWidget;

export interface LayoutDocument {
  version: 1;
  name: string;
  canvas: { width: number; height: number };
  palette: Palette;
  widgets: Widget[];
  paletteMode?: 'saved' | 'live';
}

const MAX_CANVAS_SIZE = 16384;
const PALETTE_COLORS = [
  'background', 'surface', 'surfaceRaised', 'text', 'muted', 'primary', 'secondary', 'outline',
] as const;
const GEOMETRY_KEYS = ['x', 'y', 'width', 'height'] as const;
const METRIC_SETTINGS = ['label', 'value', 'unit', 'detail'] as const;
const WEATHER_SETTINGS = ['location', 'temperature', 'unit', 'condition', 'high', 'low'] as const;

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function object(input: unknown, path: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(path, 'expected an object');
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, 'expected a plain JSON object');
  }
  return input as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, keys: readonly string[], path: string, optional: readonly string[] = []): void {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || ![...keys, ...optional].includes(key)) {
      fail(`${path}.${String(key)}`, 'unexpected field');
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) fail(`${path}.${key}`, 'required field is missing');
  }
}

function optionalChoice<T extends string>(input: Record<string, unknown>, key: string, path: string, choices: readonly T[]): T | undefined {
  if (!Object.hasOwn(input, key)) return undefined;
  const value = input[key];
  if (typeof value !== 'string' || !choices.includes(value as T)) fail(`${path}.${key}`, `expected ${choices.join(', ')}`);
  return value as T;
}

function string(input: unknown, path: string, nonempty = false): string {
  if (typeof input !== 'string') fail(path, 'expected a string');
  if (nonempty && input.trim().length === 0) fail(path, 'must not be empty');
  return input;
}

function integer(input: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    fail(path, 'expected a safe integer');
  }
  if (input < min || input > max) fail(path, `must be between ${min} and ${max}`);
  return input === 0 ? 0 : input;
}

function color(input: unknown, path: string): string {
  const value = string(input, path);
  if (value.length !== 7 || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    fail(path, 'expected a six-digit #hex color');
  }
  return value;
}

function palette(input: unknown, path: string): Palette {
  const value = object(input, path);
  exactKeys(value, ['name', ...PALETTE_COLORS], path);
  return {
    name: string(value.name, `${path}.name`),
    background: color(value.background, `${path}.background`),
    surface: color(value.surface, `${path}.surface`),
    surfaceRaised: color(value.surfaceRaised, `${path}.surfaceRaised`),
    text: color(value.text, `${path}.text`),
    muted: color(value.muted, `${path}.muted`),
    primary: color(value.primary, `${path}.primary`),
    secondary: color(value.secondary, `${path}.secondary`),
    outline: color(value.outline, `${path}.outline`),
  };
}

function widget(input: unknown, path: string, canvas: LayoutDocument['canvas']): Widget {
  const value = object(input, path);
  exactKeys(value, ['id', 'type', ...GEOMETRY_KEYS, 'settings'], path);
  const id = string(value.id, `${path}.id`, true);
  if (value.type !== 'metric' && value.type !== 'weather') {
    fail(`${path}.type`, 'unsupported widget type; expected "metric" or "weather"');
  }
  const geometry: Geometry = {
    x: integer(value.x, `${path}.x`, 0),
    y: integer(value.y, `${path}.y`, 0),
    width: integer(value.width, `${path}.width`, 1),
    height: integer(value.height, `${path}.height`, 1),
  };
  if (geometry.x > canvas.width - geometry.width) {
    fail(`${path}.width`, 'x + width must fit inside canvas.width');
  }
  if (geometry.y > canvas.height - geometry.height) {
    fail(`${path}.height`, 'y + height must fit inside canvas.height');
  }
  const settings = object(value.settings, `${path}.settings`);
  if (value.type === 'metric') {
    exactKeys(settings, METRIC_SETTINGS, `${path}.settings`, ['source']);
    const source = optionalChoice(settings, 'source', `${path}.settings`, metricSources);
    return {
      id, type: 'metric', ...geometry,
      settings: {
        label: string(settings.label, `${path}.settings.label`),
        value: string(settings.value, `${path}.settings.value`),
        unit: string(settings.unit, `${path}.settings.unit`),
        detail: string(settings.detail, `${path}.settings.detail`),
        ...(source === undefined ? {} : { source }),
      },
    };
  }
  exactKeys(settings, WEATHER_SETTINGS, `${path}.settings`, ['source']);
  const source = optionalChoice(settings, 'source', `${path}.settings`, ['sample', 'weather'] as const);
  return {
    id, type: 'weather', ...geometry,
    settings: {
      location: string(settings.location, `${path}.settings.location`),
      temperature: string(settings.temperature, `${path}.settings.temperature`),
      unit: string(settings.unit, `${path}.settings.unit`),
      condition: string(settings.condition, `${path}.settings.condition`),
      high: string(settings.high, `${path}.settings.high`),
      low: string(settings.low, `${path}.settings.low`),
      ...(source === undefined ? {} : { source }),
    },
  };
}

/** Validate unknown data and return a detached document in canonical key order. */
export function validateLayout(input: unknown): LayoutDocument {
  const value = object(input, '$');
  if (!Object.hasOwn(value, 'version')) fail('$.version', 'required field is missing; choose a TURZX layout JSON file');
  if (value.version !== 1) fail('$.version', 'unsupported layout version; expected 1');
  exactKeys(value, ['version', 'name', 'canvas', 'palette', 'widgets'], '$', ['paletteMode']);
  const paletteMode = optionalChoice(value, 'paletteMode', '$', ['saved', 'live'] as const);
  const name = string(value.name, '$.name', true);
  const canvasValue = object(value.canvas, '$.canvas');
  exactKeys(canvasValue, ['width', 'height'], '$.canvas');
  const canvas = {
    width: integer(canvasValue.width, '$.canvas.width', 1, MAX_CANVAS_SIZE),
    height: integer(canvasValue.height, '$.canvas.height', 1, MAX_CANVAS_SIZE),
  };
  const validatedPalette = palette(value.palette, '$.palette');
  if (!Array.isArray(value.widgets)) fail('$.widgets', 'expected an array');
  const ids = new Set<string>();
  // Array.from also visits sparse slots supplied directly to validateLayout.
  const widgets = Array.from(value.widgets, (inputWidget: unknown, index) => {
    const path = `$.widgets[${index}]`;
    const validated = widget(inputWidget, path, canvas);
    if (ids.has(validated.id)) fail(`${path}.id`, `duplicate widget ID "${validated.id}"`);
    ids.add(validated.id);
    return validated;
  });
  return { version: 1, name, canvas, palette: validatedPalette, widgets, ...(paletteMode === undefined ? {} : { paletteMode }) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail('$', `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseLayout(text: string): LayoutDocument {
  return validateLayout(parseJson(text));
}

export function serializeLayout(doc: LayoutDocument): string {
  return `${JSON.stringify(validateLayout(doc), null, 2)}\n`;
}

// Snapshot of the live Caelestia scheme. These colors also serve as the offline fallback.
const SAMPLE_LAYOUT: LayoutDocument = {
  version: 1,
  name: 'TURZX sample',
  canvas: { width: 1280, height: 800 },
  palette: {
    name: 'dynamic',
    background: '#0a0f0f', surface: '#131b1b', surfaceRaised: '#192121',
    text: '#dce8e7', muted: '#a2adad', primary: '#9bd0d1', secondary: '#b0cccc', outline: '#3f4a4a',
  },
  widgets: [
    {
      id: 'cpu', type: 'metric', x: 64, y: 160, width: 352, height: 224,
      settings: { label: 'CPU load', value: '24', unit: '%', detail: '8 cores · 42 °C' },
    },
    {
      id: 'gpu', type: 'metric', x: 440, y: 160, width: 352, height: 224,
      settings: { label: 'GPU load', value: '18', unit: '%', detail: '6.2 / 16 GB VRAM' },
    },
    {
      id: 'memory', type: 'metric', x: 64, y: 408, width: 728, height: 240,
      settings: { label: 'Memory', value: '12.4', unit: 'GB', detail: '32 GB installed · 39% used' },
    },
    {
      id: 'weather', type: 'weather', x: 816, y: 160, width: 400, height: 488,
      settings: { location: 'Paris', temperature: '19', unit: '°C', condition: 'Partly cloudy', high: '22', low: '14' },
    },
  ],
};

export function createSampleLayout(): LayoutDocument {
  return validateLayout(SAMPLE_LAYOUT);
}

function finite(input: unknown, path: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) fail(path, 'expected a finite number');
  return input;
}

function clampRounded(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Resize at the existing position first, then clamp movement using the resulting size. */
export function updateGeometry(doc: LayoutDocument, id: string, patch: Partial<Geometry>): LayoutDocument {
  const index = doc.widgets.findIndex((entry) => entry.id === id);
  const current = doc.widgets[index];
  if (!current) fail('$.widgets', `widget ID "${id}" was not found`);
  const edits = object(patch, '$.geometry');
  for (const key of Object.keys(edits)) {
    if (!(GEOMETRY_KEYS as readonly string[]).includes(key)) fail(`$.geometry.${key}`, 'unexpected field');
    finite(edits[key], `$.geometry.${key}`);
  }
  const width = Object.hasOwn(edits, 'width')
    ? clampRounded(finite(edits.width, '$.geometry.width'), 1, doc.canvas.width - current.x)
    : current.width;
  const height = Object.hasOwn(edits, 'height')
    ? clampRounded(finite(edits.height, '$.geometry.height'), 1, doc.canvas.height - current.y)
    : current.height;
  const x = Object.hasOwn(edits, 'x')
    ? clampRounded(finite(edits.x, '$.geometry.x'), 0, doc.canvas.width - width)
    : current.x;
  const y = Object.hasOwn(edits, 'y')
    ? clampRounded(finite(edits.y, '$.geometry.y'), 0, doc.canvas.height - height)
    : current.y;
  if (x === current.x && y === current.y && width === current.width && height === current.height) return doc;
  const widgets = doc.widgets.slice();
  widgets[index] = { ...current, x, y, width, height };
  return { ...doc, widgets };
}

/** Deltas are document pixels, independent of preview scale. */
export function moveWidget(doc: LayoutDocument, id: string, dx: number, dy: number): LayoutDocument {
  finite(dx, '$.delta.x');
  finite(dy, '$.delta.y');
  const current = doc.widgets.find((entry) => entry.id === id);
  if (!current) fail('$.widgets', `widget ID "${id}" was not found`);
  return updateGeometry(doc, id, { x: current.x + dx, y: current.y + dy });
}

function positive(input: number, path: string): number {
  finite(input, path);
  if (input <= 0) fail(path, 'must be greater than zero');
  return input;
}

export function fitCanvas(
  canvasWidth: number, canvasHeight: number, viewportWidth: number, viewportHeight: number,
): { scale: number; offsetX: number; offsetY: number } {
  positive(canvasWidth, '$.canvas.width');
  positive(canvasHeight, '$.canvas.height');
  positive(viewportWidth, '$.viewport.width');
  positive(viewportHeight, '$.viewport.height');
  const scale = Math.min(viewportWidth / canvasWidth, viewportHeight / canvasHeight);
  positive(scale, '$.scale');
  return {
    scale,
    offsetX: (viewportWidth - canvasWidth * scale) / 2,
    offsetY: (viewportHeight - canvasHeight * scale) / 2,
  };
}

/** Pass total displacement from the drag origin, rather than successive rounded steps. */
export function pointerDeltaToDocument(dx: number, dy: number, scale: number): { x: number; y: number } {
  finite(dx, '$.pointer.x');
  finite(dy, '$.pointer.y');
  positive(scale, '$.scale');
  const x = Math.round(finite(dx / scale, '$.delta.x'));
  const y = Math.round(finite(dy / scale, '$.delta.y'));
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}

export function parseCaelestiaPalette(text: string): Palette {
  const value = object(parseJson(text), '$');
  const colours = object(value.colours ?? value.colors, '$.colours');
  const mappedColor = (key: string): string => {
    const raw = string(colours[key], `$.colours.${key}`);
    const prefixed = raw.startsWith('#') ? raw : `#${raw}`;
    return color(prefixed, `$.colours.${key}`).toLowerCase();
  };
  return {
    name: Object.hasOwn(value, 'name') ? string(value.name, '$.name', true) : 'Caelestia',
    background: mappedColor('background'),
    surface: mappedColor('surfaceContainer'),
    surfaceRaised: mappedColor('surfaceContainerHigh'),
    text: mappedColor('onSurface'),
    muted: mappedColor('onSurfaceVariant'),
    primary: mappedColor('primary'),
    secondary: mappedColor('secondary'),
    outline: mappedColor('outlineVariant'),
  };
}
