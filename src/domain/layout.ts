import { isUsageSummary, usageSources } from './usage';
import { dashboardSources, isDashboardSource } from './dashboardData';
import { validateWidgetDesign } from './design';
import type { WidgetDesign } from './design';
import { trendSources } from './trend';
import type { TrendSource } from './trend';
import { LIST_MAX_ROWS } from './list';
import { calendarWeekStarts } from './calendar';
import type { CalendarWeekStart } from './calendar';

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

export const paletteColorKeys = [
  'background', 'surface', 'surfaceRaised', 'text', 'muted', 'primary', 'secondary', 'outline',
] as const;
export type PaletteColorKey = typeof paletteColorKeys[number];
export type WidgetColors = Partial<Record<PaletteColorKey, string>>;

export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WidgetPresentation { design?: WidgetDesign; colors?: WidgetColors }

export interface MetricWidget extends Geometry, WidgetPresentation {
  id: string;
  type: 'metric';
  settings: { label: string; value: string; unit: string; detail: string; source?: MetricSource; trend?: boolean };
}

export const metricSources = ['sample', 'cpu', 'gpu', 'memory', 'disk', 'network-down', 'network-up', 'cpu-temperature', 'gpu-temperature', ...usageSources, ...dashboardSources] as const;
export type MetricSource = typeof metricSources[number];

export interface WeatherWidget extends Geometry, WidgetPresentation {
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

export interface ClockWidget extends Geometry, WidgetPresentation {
  id: string;
  type: 'clock';
  settings: { label: string; time: string; date: string; format: '24h' | '12h'; showDate: boolean; source?: 'sample' | 'clock' };
}

export interface TextWidget extends Geometry, WidgetPresentation {
  id: string;
  type: 'text';
  settings: { label: string; text: string };
}

/** Limits apply to the complete ASCII data URI and to decoded PNG bytes. */
export const MAX_IMAGE_DATA_BYTES = 512 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const imageFits = ['contain', 'cover', 'stretch'] as const;
export type ImageFit = typeof imageFits[number];
export interface ImageWidget extends Geometry, WidgetPresentation {
  id: string;
  type: 'image';
  settings: { label: string; data: string; fit: ImageFit; opacity: number };
}

export const gaugeStyles = ['arc', 'ring', 'bar', 'segments', 'thermometer', 'number'] as const;
export type GaugeStyle = typeof gaugeStyles[number];

export interface GaugeWidget extends Geometry, WidgetPresentation {
  id: string;
  type: 'gauge';
  settings: { label: string; value: number; min: number; max: number; unit: string; detail: string; source?: MetricSource; style?: GaugeStyle };
}

export const storageStyles = ['bars', 'table'] as const;
export interface StorageWidget extends Geometry, WidgetPresentation {
  id: string;
  type: 'storage';
  settings: { label: string; style: typeof storageStyles[number]; source?: 'sample' | 'mounted-storage'; grouping?: 'drives' | 'partitions'; mounts?: string[] };
}

/** Sources with live history. List, graph and calendar labels are bounded so they fit a card. */
export type SensorSource = TrendSource;
export const MAX_CARD_LABEL = 64;
export const MAX_ROW_LABEL = 32;
export const MAX_ROW_VALUE = 16;
export const MAX_ROW_UNIT = 8;

export interface ListRow { source: SensorSource; label: string; value: string; unit: string }
export interface ListWidget extends Geometry, WidgetPresentation {
  id: string;
  type: 'list';
  settings: { label: string; rows: ListRow[]; bars: boolean };
}

export const graphStyles = ['area', 'line'] as const;
export type GraphStyle = typeof graphStyles[number];
export interface GraphWidget extends Geometry, WidgetPresentation {
  id: string;
  type: 'graph';
  settings: { label: string; style: GraphStyle; sources: [SensorSource] | [SensorSource, SensorSource] };
}

export interface CalendarWidget extends Geometry, WidgetPresentation {
  id: string;
  type: 'calendar';
  settings: { label: string; source: 'sample' | 'clock'; weekStart: CalendarWeekStart };
}

export const widgetTypes = ['metric', 'weather', 'clock', 'text', 'gauge', 'storage', 'image', 'list', 'graph', 'calendar'] as const;
export type Widget = MetricWidget | WeatherWidget | ClockWidget | TextWidget | GaugeWidget | StorageWidget | ImageWidget | ListWidget | GraphWidget | CalendarWidget;

export interface LayoutDocument {
  version: 1;
  name: string;
  canvas: { width: number; height: number };
  palette: Palette;
  widgets: Widget[];
  paletteMode?: 'saved' | 'live';
  chrome?: 'standard' | 'none';
}

const MAX_CANVAS_SIZE = 16384;
const MAX_LAYOUT_BYTES = 1024 * 1024;
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

function bounded(input: unknown, path: string, max: number): string {
  const value = string(input, path);
  // Count code points, as Python does.
  if ([...value].length > max) fail(path, `must be at most ${max} characters`);
  return value;
}

function sensorSource(input: unknown, path: string): SensorSource {
  if (typeof input !== 'string' || !(trendSources as readonly string[]).includes(input)) fail(path, `expected ${trendSources.join(', ')}`);
  return input as SensorSource;
}

function color(input: unknown, path: string): string {
  const value = string(input, path);
  if (value.length !== 7 || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    fail(path, 'expected a six-digit #hex color');
  }
  return value;
}

/** Synchronous, platform-independent PNG structure validation. Pillow also verifies pixels at runtime. */
function imageData(input: unknown, path: string): string {
  const data = string(input, path);
  if (data.length > MAX_IMAGE_DATA_BYTES) fail(path, 'image exceeds the 512 KiB limit; resize or compress it before importing');
  const prefix = 'data:image/png;base64,';
  if (!data.startsWith(prefix)) fail(path, 'expected an embedded PNG data URI; import an image to convert it to PNG');
  const encoded = data.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail(path, 'invalid PNG base64');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if ((padding === 2 && (alphabet.indexOf(encoded.at(-3)!) & 15) !== 0) ||
      (padding === 1 && (alphabet.indexOf(encoded.at(-2)!) & 3) !== 0)) fail(path, 'invalid PNG base64 padding');
  const bytes = new Uint8Array(encoded.length / 4 * 3 - padding);
  if (bytes.length > MAX_IMAGE_DATA_BYTES) fail(path, 'decoded PNG exceeds the 512 KiB limit');
  for (let i = 0, offset = 0; i < encoded.length; i += 4) {
    const word = (alphabet.indexOf(encoded[i]) << 18) | (alphabet.indexOf(encoded[i + 1]) << 12) |
      (Math.max(0, alphabet.indexOf(encoded[i + 2])) << 6) | Math.max(0, alphabet.indexOf(encoded[i + 3]));
    for (const shift of [16, 8, 0]) if (offset < bytes.length) bytes[offset++] = (word >>> shift) & 255;
  }
  const invalid = (): never => fail(path, 'invalid or unsupported PNG image');
  if (bytes.length < 57 || [137, 80, 78, 71, 13, 10, 26, 10].some((byte, i) => bytes[i] !== byte)) invalid();
  const view = new DataView(bytes.buffer);
  let offset = 8, hasData = false, ended = false, hasPalette = false, dataEnded = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()) invalid();
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end - 4; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) invalid();
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) invalid();
      const width = view.getUint32(offset + 8), height = view.getUint32(offset + 12);
      if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) fail(path, 'PNG dimensions must be at most 4096 per side and 16 million pixels');
      const depth = bytes[offset + 16], color = bytes[offset + 17];
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) invalid();
    } else if (type === 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(type)) invalid();
    else if (type === 'PLTE') {
      if (hasPalette || hasData || !length || length > 768 || length % 3) invalid();
      hasPalette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (bytes[25] === 3 && !hasPalette)) invalid();
      hasData = true;
    } else if (type === 'IEND') {
      if (length !== 0 || !hasData || end !== bytes.length) invalid();
      ended = true;
    } else {
      if (type[0] === type[0].toUpperCase()) invalid();
      if (hasData) dataEnded = true;
    }
    offset = end;
  }
  if (!ended || offset !== bytes.length) invalid();
  return data;
}

function palette(input: unknown, path: string): Palette {
  const value = object(input, path);
  exactKeys(value, ['name', ...paletteColorKeys], path);
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

/** Return detached overrides in palette role order, rejecting empty objects. */
export function validateWidgetColors(input: unknown, path: string): WidgetColors {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(path, 'expected a plain JSON object');
  const value = object(input, path);
  exactKeys(value, [], path, paletteColorKeys);
  if (!Reflect.ownKeys(value).length) fail(path, 'remove the empty object');
  const colors: WidgetColors = {};
  for (const key of paletteColorKeys) {
    if (Object.hasOwn(value, key)) colors[key] = color(value[key], `${path}.${key}`);
  }
  return colors;
}

function widgetContent(input: unknown, path: string, canvas: LayoutDocument['canvas']): Widget {
  const value = object(input, path);
  exactKeys(value, ['id', 'type', ...GEOMETRY_KEYS, 'settings'], path, ['design', 'colors']);
  const id = string(value.id, `${path}.id`, true);
  if (typeof value.type !== 'string' || !(widgetTypes as readonly string[]).includes(value.type)) {
    fail(`${path}.type`, `unsupported widget type; expected ${widgetTypes.join(', ')}`);
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
  const settingsPath = `${path}.settings`;
  if (value.type === 'list') {
    exactKeys(settings, ['label', 'rows', 'bars'], settingsPath);
    const label = bounded(settings.label, `${settingsPath}.label`, MAX_CARD_LABEL);
    if (!Array.isArray(settings.rows) || settings.rows.length < 1 || settings.rows.length > LIST_MAX_ROWS) fail(`${settingsPath}.rows`, `expected 1 to ${LIST_MAX_ROWS} rows`);
    const rows = (settings.rows as unknown[]).map((entry, index): ListRow => {
      const rowPath = `${settingsPath}.rows[${index}]`;
      const row = object(entry, rowPath);
      exactKeys(row, ['source', 'label', 'value', 'unit'], rowPath);
      return { source: sensorSource(row.source, `${rowPath}.source`), label: bounded(row.label, `${rowPath}.label`, MAX_ROW_LABEL),
        value: bounded(row.value, `${rowPath}.value`, MAX_ROW_VALUE), unit: bounded(row.unit, `${rowPath}.unit`, MAX_ROW_UNIT) };
    });
    if (new Set(rows.map((row) => row.source)).size !== rows.length) fail(`${settingsPath}.rows`, 'each row needs a different source');
    if (typeof settings.bars !== 'boolean') fail(`${settingsPath}.bars`, 'expected a boolean');
    return { id, type: 'list', ...geometry, settings: { label, rows, bars: settings.bars } };
  }
  if (value.type === 'graph') {
    exactKeys(settings, ['label', 'style', 'sources'], settingsPath);
    const label = bounded(settings.label, `${settingsPath}.label`, MAX_CARD_LABEL);
    const style = optionalChoice(settings, 'style', settingsPath, graphStyles)!;
    if (!Array.isArray(settings.sources) || settings.sources.length < 1 || settings.sources.length > 2) fail(`${settingsPath}.sources`, 'expected one or two sources');
    const sources = (settings.sources as unknown[]).map((source, index) => sensorSource(source, `${settingsPath}.sources[${index}]`));
    if (new Set(sources).size !== sources.length) fail(`${settingsPath}.sources`, 'expected different sources');
    return { id, type: 'graph', ...geometry, settings: { label, style, sources: sources as GraphWidget['settings']['sources'] } };
  }
  if (value.type === 'calendar') {
    exactKeys(settings, ['label', 'source', 'weekStart'], settingsPath);
    return { id, type: 'calendar', ...geometry, settings: {
      label: bounded(settings.label, `${settingsPath}.label`, MAX_CARD_LABEL),
      source: optionalChoice(settings, 'source', settingsPath, ['sample', 'clock'] as const)!,
      weekStart: optionalChoice(settings, 'weekStart', settingsPath, calendarWeekStarts)!,
    } };
  }
  if (value.type === 'image') {
    exactKeys(settings, ['label', 'data', 'fit', 'opacity'], settingsPath);
    return { id, type: 'image', ...geometry, settings: {
      label: string(settings.label, `${settingsPath}.label`),
      data: imageData(settings.data, `${settingsPath}.data`),
      fit: optionalChoice(settings, 'fit', settingsPath, imageFits)!,
      opacity: integer(settings.opacity, `${settingsPath}.opacity`, 0, 100),
    } };
  }
  if (value.type === 'storage') {
    exactKeys(settings, ['label', 'style'], settingsPath, ['source', 'grouping', 'mounts']);
    const style = optionalChoice(settings, 'style', settingsPath, storageStyles)!;
    const source = optionalChoice(settings, 'source', settingsPath, ['sample', 'mounted-storage'] as const);
    const grouping = optionalChoice(settings, 'grouping', settingsPath, ['drives', 'partitions'] as const);
    let mounts: string[] | undefined;
    if (Object.hasOwn(settings, 'mounts')) {
      if (!Array.isArray(settings.mounts) || settings.mounts.length < 1 || settings.mounts.length > 32 || settings.mounts.some((mount) => typeof mount !== 'string' || !mount.startsWith('/') || mount.length > 256 || /[\u0000-\u001f\u007f]/.test(mount)) || new Set(settings.mounts).size !== settings.mounts.length) fail(`${settingsPath}.mounts`, 'expected 1 to 32 unique absolute mount paths');
      if (grouping === 'drives') fail(`${settingsPath}.mounts`, 'mount filters require the partitions view');
      mounts = [...settings.mounts] as string[];
    }
    return { id, type: 'storage', ...geometry, settings: {
      label: string(settings.label, `${settingsPath}.label`), style,
      ...(grouping === undefined ? {} : { grouping }),
      ...(mounts === undefined ? {} : { mounts }),
      ...(source === undefined ? {} : { source }),
    } };
  }
  if (value.type === 'text') {
    exactKeys(settings, ['label', 'text'], settingsPath);
    return { id, type: 'text', ...geometry, settings: {
      label: string(settings.label, `${settingsPath}.label`), text: string(settings.text, `${settingsPath}.text`),
    } };
  }
  if (value.type === 'clock') {
    exactKeys(settings, ['label', 'time', 'date', 'format', 'showDate'], settingsPath, ['source']);
    const format = optionalChoice(settings, 'format', settingsPath, ['24h', '12h'] as const)!;
    const source = optionalChoice(settings, 'source', settingsPath, ['sample', 'clock'] as const);
    if (typeof settings.showDate !== 'boolean') fail(`${settingsPath}.showDate`, 'expected a boolean');
    return { id, type: 'clock', ...geometry, settings: {
      label: string(settings.label, `${settingsPath}.label`), time: string(settings.time, `${settingsPath}.time`),
      date: string(settings.date, `${settingsPath}.date`), format, showDate: settings.showDate,
      ...(source === undefined ? {} : { source }),
    } };
  }
  if (value.type === 'gauge') {
    exactKeys(settings, ['label', 'value', 'min', 'max', 'unit', 'detail'], settingsPath, ['source', 'style']);
    const style = optionalChoice(settings, 'style', settingsPath, gaugeStyles);
    const min = finite(settings.min, `${settingsPath}.min`);
    const max = finite(settings.max, `${settingsPath}.max`);
    const valueNumber = finite(settings.value, `${settingsPath}.value`);
    if (max <= min) fail(`${settingsPath}.max`, 'must be greater than min');
    if (valueNumber < min || valueNumber > max) fail(`${settingsPath}.value`, 'must be between min and max');
    const source = optionalChoice(settings, 'source', settingsPath, metricSources);
    if (isUsageSummary(source) || isDashboardSource(source)) fail(`${settingsPath}.source`, 'summary sources require a metric card');
    return { id, type: 'gauge', ...geometry, settings: {
      label: string(settings.label, `${settingsPath}.label`), value: valueNumber, min, max,
      unit: string(settings.unit, `${settingsPath}.unit`), detail: string(settings.detail, `${settingsPath}.detail`),
      ...(style === undefined ? {} : { style }),
      ...(source === undefined ? {} : { source }),
    } };
  }
  if (value.type === 'metric') {
    exactKeys(settings, METRIC_SETTINGS, `${path}.settings`, ['source', 'trend']);
    const source = optionalChoice(settings, 'source', `${path}.settings`, metricSources);
    if (Object.hasOwn(settings, 'trend') && typeof settings.trend !== 'boolean') {
      fail(`${path}.settings.trend`, 'expected a boolean');
    }
    if (isDashboardSource(source) && settings.trend === true) fail(`${path}.settings.trend`, 'summary sources do not support a trend');
    return {
      id, type: 'metric', ...geometry,
      settings: {
        label: string(settings.label, `${path}.settings.label`),
        value: string(settings.value, `${path}.settings.value`),
        unit: string(settings.unit, `${path}.settings.unit`),
        detail: string(settings.detail, `${path}.settings.detail`),
        ...(source === undefined ? {} : { source }),
        ...(Object.hasOwn(settings, 'trend') ? { trend: settings.trend as boolean } : {}),
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

function widget(input: unknown, path: string, canvas: LayoutDocument['canvas']): Widget {
  const result = widgetContent(input, path, canvas);
  const value = input as Record<string, unknown>;
  return {
    ...result,
    ...(Object.hasOwn(value, 'design') ? { design: validateWidgetDesign(value.design, result.type, `${path}.design`) } : {}),
    ...(Object.hasOwn(value, 'colors') ? { colors: validateWidgetColors(value.colors, `${path}.colors`) } : {}),
  };
}

/** Validate unknown data and return a detached document in canonical key order. */
export function validateLayout(input: unknown): LayoutDocument {
  const value = object(input, '$');
  if (!Object.hasOwn(value, 'version')) fail('$.version', 'required field is missing; choose a TURZX layout JSON file');
  if (value.version !== 1) fail('$.version', 'unsupported layout version; expected 1');
  exactKeys(value, ['version', 'name', 'canvas', 'palette', 'widgets'], '$', ['paletteMode', 'chrome']);
  const paletteMode = optionalChoice(value, 'paletteMode', '$', ['saved', 'live'] as const);
  const chrome = optionalChoice(value, 'chrome', '$', ['standard', 'none'] as const);
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
  return { version: 1, name, canvas, palette: validatedPalette, widgets, ...(paletteMode === undefined ? {} : { paletteMode }), ...(chrome === undefined ? {} : { chrome }) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail('$', `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseLayout(text: string): LayoutDocument {
  layoutSize(text);
  return validateLayout(parseJson(text));
}

export function serializeLayout(doc: LayoutDocument): string {
  const text = `${JSON.stringify(validateLayout(doc), null, 2)}\n`;
  layoutSize(text);
  return text;
}

function layoutSize(text: string): void {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MAX_LAYOUT_BYTES) fail('$', 'layout exceeds the 1 MiB limit; resize or remove embedded images, or shorten text');
  }
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
