import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { MAX_IMAGE_DATA_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, serializeLayout, validateLayout } from './layout';
import type { Geometry, LayoutDocument, MetricSource, Palette } from './layout';

export interface ExternalThemeAsset { name: string; data: string; width: number; height: number }
export interface ExternalThemeConversion { document: LayoutDocument; warnings: string[]; format: string }
export const MAX_EXTERNAL_THEME_BYTES = 1024 * 1024;
export const MAX_EXTERNAL_ASSETS = 64;
export const MAX_EXTERNAL_WIDGETS = 256;
export const MAX_EXTERNAL_IMAGE_BYTES = MAX_IMAGE_DATA_BYTES;
export const MAX_EXTERNAL_DOCUMENT_BYTES = 1024 * 1024;
export const AIDA64_IMPORT_GUIDANCE = 'AIDA64 .sensorpanel and .rslcd files cannot be converted by this importer. Open the panel in AIDA64, export or save its background as an image, select that image in Studio, and recreate the sensor widgets using Studio data sources. A screenshot can be a visual reference; it does not create live sensor widgets.';

const sizes: Readonly<Record<string, readonly [number, number]>> = {
  '0.96"': [80, 160], '2.1"': [480, 480], '2.8"': [480, 480], '3.5"': [320, 480],
  '4.6"': [320, 960], '5"': [480, 800], '5.2"': [720, 1280], '8"': [800, 1280],
  '8.8"': [480, 1920], '9.2"': [480, 1920], '12.3"': [720, 1920],
};
interface Sensor { source: MetricSource; label: string; unit: string; value: number }
const sensors: Readonly<Record<string, Sensor>> = {
  'CPU.PERCENTAGE': { source: 'cpu', label: 'CPU usage', unit: '%', value: 24 },
  'CPU.TEMPERATURE': { source: 'cpu-temperature', label: 'CPU temperature', unit: '°C', value: 52 },
  'GPU.PERCENTAGE': { source: 'gpu', label: 'GPU usage', unit: '%', value: 41 },
  'GPU.TEMPERATURE': { source: 'gpu-temperature', label: 'GPU temperature', unit: '°C', value: 48 },
  'MEMORY.VIRTUAL': { source: 'memory', label: 'Memory usage', unit: '%', value: 62 },
};
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor', '<<']);
type Fields = Record<string, unknown>;
function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
function utf8Size(text: string): number {
  let bytes = 0;
  for (const char of text) { const code = char.codePointAt(0)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
  return bytes;
}
function fields(value: unknown, path: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'expected a mapping');
  return value as Fields;
}
function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 8192) fail(path, 'expected text of at most 8192 characters');
  return value;
}
function integer(value: unknown, path: string, min = 0, max = 16384): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(path, `expected an integer between ${min} and ${max}`);
  return value === 0 ? 0 : value;
}
function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) fail(path, 'expected a finite number between -1000000 and 1000000');
  return value;
}
function basename(value: unknown, path: string): string {
  const name = string(value, path);
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f:%?#]/.test(name) || /^[\\/]/.test(name)) fail(path, 'use a safe relative image path, without URLs or absolute paths');
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail(path, 'image paths cannot contain empty, . or .. segments');
  return parts[parts.length - 1].toLowerCase();
}

/** Inspect nodes before materializing objects. No aliases, tags, merges or executable values. */
function readTheme(text: string): Fields {
  if (text.length > MAX_EXTERNAL_THEME_BYTES || utf8Size(text) > MAX_EXTERNAL_THEME_BYTES) throw new Error('Choose a theme YAML file of at most 1 MB.');
  if (!text.trim()) throw new Error('Choose a Turing theme.yaml file containing display and drawable sections.');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(text) || /^\s*(?:<|PK\x03\x04|AIDA64|\[)/i.test(text)) throw new Error(AIDA64_IMPORT_GUIDANCE);
  let parsed;
  try { parsed = parseDocument(text, { uniqueKeys: true, version: '1.2', strict: true }); }
  catch { throw new Error('Cannot parse this theme. Choose a Turing theme.yaml text file. ' + AIDA64_IMPORT_GUIDANCE); }
  if (parsed.errors.length || parsed.warnings.length) throw new Error(`Cannot parse theme YAML: ${parsed.errors[0]?.message ?? parsed.warnings[0].message}`);
  let count = 0;
  function inspect(node: unknown, depth: number): void {
    if (++count > 10000 || depth > 16) throw new Error('Theme YAML is too complex. Use at most 10000 nodes and 16 nesting levels.');
    if (node === null) return;
    if (isAlias(node)) throw new Error('YAML aliases are unsupported. Expand each theme entry explicitly.');
    if (isMap(node) || isSeq(node) || isScalar(node)) {
      if (node.tag || node.anchor) throw new Error('YAML tags and anchors are unsupported. Use plain theme values.');
      if (isMap(node)) {
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('Theme mapping keys must be strings.');
          if (forbiddenKeys.has(pair.key.value)) throw new Error(`Unsafe YAML key "${pair.key.value}" is unsupported.`);
          string(pair.key.value, 'YAML key');
          inspect(pair.value, depth + 1);
        }
      } else if (isSeq(node)) {
        for (const item of node.items) inspect(item, depth + 1);
      } else if (typeof node.value === 'string') string(node.value, 'YAML value');
      else if (node.value !== null && !['number', 'boolean'].includes(typeof node.value)) throw new Error('Unsupported YAML value.');
      return;
    }
    throw new Error('Unsupported YAML node.');
  }
  inspect(parsed.contents, 0);
  const value: unknown = parsed.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported theme format. Choose a Turing theme.yaml file. ' + AIDA64_IMPORT_GUIDANCE);
  return fields(value, 'theme');
}

function selectedAssets(assets: readonly ExternalThemeAsset[]): Map<string, ExternalThemeAsset> {
  if (!Array.isArray(assets) || assets.length > MAX_EXTERNAL_ASSETS) throw new Error('Select at most 64 image assets.');
  const result = new Map<string, ExternalThemeAsset>();
  let total = 0;
  for (const [index, asset] of assets.entries()) {
    const path = `assets[${index}]`;
    fields(asset, path);
    const name = basename(asset.name, `${path}.name`);
    if (result.has(name)) fail(path, 'duplicate image basename; select one file per basename');
    const width = integer(asset.width, `${path}.width`, 1, MAX_IMAGE_DIMENSION);
    const height = integer(asset.height, `${path}.height`, 1, MAX_IMAGE_DIMENSION);
    if (width * height > MAX_IMAGE_PIXELS) fail(path, 'image must contain at most 16 million pixels');
    if (typeof asset.data !== 'string' || asset.data.length > MAX_EXTERNAL_IMAGE_BYTES
      || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.data)) fail(path, 'select a PNG image with a data URI of at most 512 KiB');
    const encoded = asset.data.slice(22);
    if (encoded.length % 4 !== 0) fail(path, 'invalid PNG base64 length');
    const bytes = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (bytes > MAX_EXTERNAL_IMAGE_BYTES || bytes < 45) fail(path, 'select a PNG image with a data URI of at most 512 KiB');
    total += asset.data.length;
    if (total > MAX_EXTERNAL_DOCUMENT_BYTES) fail('assets', 'selected PNG assets exceed the 1 MiB encoded limit');
    // The caller decodes and normalizes images. Verify signature and IHDR dimensions again here.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const header: number[] = [];
    for (let i = 0; i < 44; i += 4) {
      const bits = alphabet.indexOf(encoded[i]) * 262144 + alphabet.indexOf(encoded[i + 1]) * 4096
        + alphabet.indexOf(encoded[i + 2]) * 64 + alphabet.indexOf(encoded[i + 3]);
      header.push((bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);
    }
    if (![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every((byte, i) => header[i] === byte)) fail(path, 'invalid PNG signature or IHDR');
    const dimension = (offset: number) => header[offset] * 16777216 + header[offset + 1] * 65536 + header[offset + 2] * 256 + header[offset + 3];
    if (dimension(16) !== width || dimension(20) !== height) fail(path, 'PNG dimensions differ from the selected image metadata');
    result.set(name, { name: asset.name, data: asset.data, width, height });
  }
  return result;
}

/** Convert a bounded subset of upstream Turing YAML into a validated, offline review draft. */
export function convertExternalTheme(text: string, assets: readonly ExternalThemeAsset[], palette: Palette): ExternalThemeConversion {
  const theme = readTheme(text);
  if (!Object.hasOwn(theme, 'display') || !['static_images', 'static_text', 'STATS'].some((key) => Object.hasOwn(theme, key))) {
    throw new Error('Unsupported theme format. Choose a Turing theme.yaml file. ' + AIDA64_IMPORT_GUIDANCE);
  }
  const images = selectedAssets(assets);
  const warnings = ['Review this draft before use. Conversion does not apply a layout or connect source sensors.', 'Source colors are ignored; Studio uses the supplied palette. Embedded images retain their original pixels.'];
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  const display = fields(theme.display, 'display');
  const size = display.DISPLAY_SIZE ?? '3.5"';
  if (typeof size !== 'string' || !Object.hasOwn(sizes, size)) fail('display.DISPLAY_SIZE', 'unsupported size; choose an upstream documented display size');
  if (!Object.hasOwn(display, 'DISPLAY_SIZE')) warn('DISPLAY_SIZE is absent; upstream defaults to 3.5 inches, giving 320 × 480 before orientation.');
  const orientation = display.DISPLAY_ORIENTATION;
  if (orientation !== 'portrait' && orientation !== 'landscape') fail('display.DISPLAY_ORIENTATION', 'expected portrait or landscape');
  const [short, long] = sizes[size];
  const canvas = orientation === 'portrait' ? { width: short, height: long } : { width: long, height: short };
  if (size === '9.2"') warn('Upstream uses a 480 × 1920 canvas for 9.2-inch themes for compatibility; this is not a device support claim.');
  if (canvas.width * canvas.height > 16_777_216) fail('display', 'canvas exceeds the 16777216 pixel limit');
  const widgets: unknown[] = [];
  let embeddedBytes = 0;
  const add = (type: string, geometry: Geometry, settings: Fields) => {
    if (widgets.length >= MAX_EXTERNAL_WIDGETS) throw new Error('Import at most 256 widgets per theme.');
    widgets.push({ id: `external-${widgets.length + 1}`, type, ...geometry, settings });
  };
  const rectangle = (entry: Fields, path: string, natural: readonly [number, number], auto = false): Geometry => {
    const x = integer(entry.X ?? 0, `${path}.X`);
    const y = integer(entry.Y ?? 0, `${path}.Y`);
    const rawWidth = integer(entry.WIDTH ?? 0, `${path}.WIDTH`);
    const rawHeight = integer(entry.HEIGHT ?? 0, `${path}.HEIGHT`);
    let width = rawWidth || natural[0], height = rawHeight || natural[1];
    if (auto) {
      if (!rawWidth) width = Math.min(width, canvas.width - x);
      if (!rawHeight) height = Math.min(height, canvas.height - y);
      if (!rawWidth || !rawHeight) warn(`${path}: text bounds were estimated from FONT_SIZE and available canvas space; review size and placement.`);
    }
    if (width < 1 || height < 1 || x + width > canvas.width || y + height > canvas.height) fail(path, 'rectangle must fit inside the imported canvas; correct source coordinates or dimensions');
    return { x, y, width, height };
  };
  const backgroundReference = (entry: Fields, path: string) => {
    if (entry.BACKGROUND_IMAGE === undefined || entry.BACKGROUND_IMAGE === null || entry.BACKGROUND_IMAGE === '') return;
    const name = basename(entry.BACKGROUND_IMAGE, `${path}.BACKGROUND_IMAGE`);
    if (!images.has(name)) warn(`${path}: missing background image "${entry.BACKGROUND_IMAGE}". Select that asset to retain its static image layer.`);
    warn(`${path}: per-element background compositing is unsupported; use a static image layer instead.`);
  };
  const appearance = (entry: Fields, path: string, allowed: readonly string[]) => {
    const ignored = Object.keys(entry).filter((key) => !allowed.includes(key) && key !== 'BACKGROUND_IMAGE');
    if (ignored.length) warn(`${path}: unsupported styles or fields ${ignored.join(', ')} were ignored. Studio fonts and widget styling replace source rendering.`);
    backgroundReference(entry, path);
  };
  const textGeometry = (entry: Fields, path: string, value: string) => {
    const font = integer(entry.FONT_SIZE ?? 10, `${path}.FONT_SIZE`, 1, 512);
    const lines = value.split('\n');
    const natural = [Math.min(16384, Math.max(24, Math.ceil(Math.max(...lines.map((line) => [...line].length)) * font * 0.65) + 16)), Math.min(16384, Math.max(24, lines.length * (font + 8))) ] as const;
    return rectangle(entry, path, natural, true);
  };
  for (const key of Object.keys(theme)) if (!['author', 'display', 'static_images', 'static_text', 'STATS'].includes(key)) warn(`theme.${key}: unsupported top-level section was ignored.`);
  for (const key of Object.keys(display)) if (!['DISPLAY_SIZE', 'DISPLAY_ORIENTATION'].includes(key)) warn(`display.${key}: device settings are ignored in an offline draft.`);
  if (theme.static_images !== undefined && theme.static_images !== null) {
    for (const [name, raw] of Object.entries(fields(theme.static_images, 'static_images'))) {
      const path = `static_images.${name}`;
      const entry = fields(raw, path);
      const reference = basename(entry.PATH, `${path}.PATH`);
      const asset = images.get(reference);
      if (!asset) { warn(`${path}: missing image "${entry.PATH}". Select that asset and retry; this image was omitted.`); continue; }
      embeddedBytes += asset.data.length;
      if (embeddedBytes > MAX_EXTERNAL_DOCUMENT_BYTES) throw new Error('Embedded image copies exceed 1 MiB. Use fewer or smaller assets.');
      const geometry = rectangle(entry, path, [asset.width, asset.height]);
      if (Boolean(entry.WIDTH) !== Boolean(entry.HEIGHT)) warn(`${path}: only one image dimension is supplied; Studio uses the asset dimension for the other side and stretch fitting. Review source cropping.`);
      appearance(entry, path, ['PATH', 'X', 'Y', 'WIDTH', 'HEIGHT']);
      add('image', geometry, { label: name, data: asset.data, fit: 'stretch', opacity: 100 });
    }
  }
  if (theme.static_text !== undefined && theme.static_text !== null) {
    for (const [name, raw] of Object.entries(fields(theme.static_text, 'static_text'))) {
      const path = `static_text.${name}`, entry = fields(raw, path), value = string(entry.TEXT, `${path}.TEXT`);
      appearance(entry, path, ['TEXT', 'X', 'Y', 'WIDTH', 'HEIGHT', 'FONT_SIZE']);
      warn(`${path}: source text typography is replaced by Studio text-card styling; FONT_SIZE only estimates missing bounds.`);
      add('text', textGeometry(entry, path, value), { label: name, text: value });
    }
  }
  if (theme.STATS !== undefined && theme.STATS !== null) {
    function walk(raw: unknown, parts: string[]): void {
      const path = `STATS.${parts.join('.')}`, entry = fields(raw, path);
      if (Object.hasOwn(entry, 'SHOW')) {
        if (typeof entry.SHOW !== 'boolean') fail(`${path}.SHOW`, 'expected a boolean');
        if (!entry.SHOW) return;
        const mode = parts[parts.length - 1], sensorPath = parts.slice(0, -1).join('.');
        const sensor = Object.hasOwn(sensors, sensorPath) ? sensors[sensorPath] : undefined;
        const textMode = mode === 'TEXT' || (sensorPath === 'MEMORY.VIRTUAL' && mode === 'PERCENT_TEXT');
        if (!sensor || (!textMode && !['GRAPH', 'RADIAL'].includes(mode))) {
          // Validate references even when their sensor or drawing mode has no mapping.
          backgroundReference(entry, path);
          warn(`${path}: unsupported sensor mapping or drawing mode; recreate this element using Studio data sources. It was omitted.`);
          return;
        }
        backgroundReference(entry, path);
        let geometry: Geometry;
        if (mode === 'RADIAL') {
          const radius = integer(entry.RADIUS ?? 1, `${path}.RADIUS`, 1, 8192);
          const x = integer(entry.X ?? 0, `${path}.X`), y = integer(entry.Y ?? 0, `${path}.Y`);
          const thickness = integer(entry.WIDTH ?? 1, `${path}.WIDTH`, 1, radius);
          void thickness;
          geometry = rectangle({ X: x - radius, Y: y - radius, WIDTH: radius * 2, HEIGHT: radius * 2 }, path, [1, 1]);
          warn(`${path}: radial angles, segmentation, line width and text placement are replaced by a Studio ring gauge.`);
        } else geometry = textMode ? textGeometry(entry, path, `100 ${sensor.unit}`) : rectangle(entry, path, [0, 0]);
        const min = number(entry.MIN_VALUE ?? 0, `${path}.MIN_VALUE`), max = number(entry.MAX_VALUE ?? 100, `${path}.MAX_VALUE`);
        if (max <= min) fail(path, 'MAX_VALUE must exceed MIN_VALUE');
        if (entry.SHOW_UNIT !== undefined && typeof entry.SHOW_UNIT !== 'boolean') fail(`${path}.SHOW_UNIT`, 'expected a boolean');
        appearance(entry, path, ['SHOW', 'SHOW_UNIT', 'X', 'Y', 'WIDTH', 'HEIGHT', 'FONT_SIZE', 'RADIUS', 'MIN_VALUE', 'MAX_VALUE']);
        warn(`${path}: mapped to Studio ${sensor.source}; source sensor selection, refresh intervals and rendering are not preserved. Preview values are deterministic samples.`);
        add('gauge', geometry, { label: sensor.label, value: Math.max(min, Math.min(max, sensor.value)), min, max, unit: entry.SHOW_UNIT === false ? '' : sensor.unit, detail: '', source: sensor.source, style: textMode ? 'number' : mode === 'GRAPH' ? 'bar' : 'ring' });
        return;
      }
      for (const [key, child] of Object.entries(entry)) {
        if (key === 'INTERVAL') continue;
        if (!child || typeof child !== 'object' || Array.isArray(child)) { warn(`${path}.${key}: unsupported sensor field was ignored.`); continue; }
        walk(child, [...parts, key]);
      }
    }
    walk(theme.STATS, []);
  }
  if (!widgets.length) throw new Error('No supported drawable elements were found. Select missing image assets, enable supported sensor elements, or recreate the theme in Studio. ' + warnings.slice(2).join(' '));
  const document = validateLayout({ version: 1, name: 'Imported Turing theme draft', canvas, palette, paletteMode: 'live', chrome: 'none', widgets });
  serializeLayout(document); // Enforce the saved-layout byte limit, including formatting, before presenting a draft.
  return { document, warnings, format: 'Turing Smart Screen Python YAML' };
}
