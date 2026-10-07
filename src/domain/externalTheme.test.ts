import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { convertExternalTheme, AIDA64_IMPORT_GUIDANCE, MAX_EXTERNAL_THEME_BYTES, MAX_EXTERNAL_IMAGE_BYTES, MAX_EXTERNAL_WIDGETS } from './externalTheme';
import { createSampleLayout, parseLayout, serializeLayout, validateLayout } from './layout';
import type { ExternalThemeAsset } from './externalTheme';

const palette = createSampleLayout().palette;
// Real PNG fixtures, including CRCs, so image validation can inspect the complete file.
function png(width: number, height: number, name = 'background.png'): ExternalThemeAsset {
  function chunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const data = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
  return { name, data: `data:image/png;base64,${data.toString('base64')}`, width, height };
}
const asset = png(320, 480);
const textOnly = `display:\n  DISPLAY_SIZE: 3.5"\n  DISPLAY_ORIENTATION: portrait\nstatic_text:\n  NOTE:\n    TEXT: "Review draft"\n    X: 20\n    Y: 400\n    WIDTH: 200\n    HEIGHT: 50\n`;
const convert = (text: string, assets: readonly ExternalThemeAsset[] = []) => convertExternalTheme(text, assets, palette);

// Shape, field names and geometry verified against the upstream theme_example.yaml,
// display.py and stats.py. Content is a small authored fixture, not a copied theme.
const representative = `---
author: "Importer test"
display:
  DISPLAY_SIZE: 3.5"
  DISPLAY_ORIENTATION: portrait
  DISPLAY_RGB_LED: 255, 0, 0
static_images:
  BACKGROUND:
    PATH: background.png
    X: 0
    Y: 0
    WIDTH: 320
    HEIGHT: 480
static_text:
  NOTE:
    TEXT: "Review draft"
    X: 20
    Y: 400
    FONT: example/font.ttf
    FONT_SIZE: 20
    FONT_COLOR: 0, 0, 0
    BACKGROUND_IMAGE: background.png
    ALIGN: left
    ANCHOR: lt
STATS:
  CPU:
    PERCENTAGE:
      INTERVAL: 1
      TEXT:
        SHOW: True
        SHOW_UNIT: True
        X: 100
        Y: 20
        FONT_SIZE: 20
      GRAPH:
        SHOW: True
        X: 115
        Y: 71
        WIDTH: 178
        HEIGHT: 13
        MIN_VALUE: 0
        MAX_VALUE: 100
      RADIAL:
        SHOW: True
        X: 100
        Y: 110
        RADIUS: 40
        WIDTH: 10
        ANGLE_START: 120
        ANGLE_END: 60
      LINE_GRAPH:
        SHOW: False
  GPU:
    PERCENTAGE:
      TEXT:
        SHOW: TRUE
        SHOW_UNIT: False
        X: 250
        Y: 140
        WIDTH: 60
        HEIGHT: 30
  MEMORY:
    VIRTUAL:
      GRAPH:
        SHOW: True
        X: 115
        Y: 215
        WIDTH: 178
        HEIGHT: 13
      PERCENT_TEXT:
        SHOW: True
        X: 250
        Y: 195
        WIDTH: 60
        HEIGHT: 30
`;

describe('Turing external theme conversion', () => {
  it('converts verified upstream shapes, ordering and exact integer coordinates into a validated review draft', () => {
    const result = convert(representative, [asset]);
    expect(result.format).toBe('Turing Smart Screen Python YAML');
    expect(result.document).toMatchObject({ canvas: { width: 320, height: 480 }, palette, paletteMode: 'live', chrome: 'none' });
    expect(result.document.widgets.map(({ type }) => type)).toEqual(['image', 'text', 'gauge', 'gauge', 'gauge', 'gauge', 'gauge', 'gauge']);
    expect(result.document.widgets.map(({ x, y, width, height }) => [x, y, width, height])).toEqual([
      [0, 0, 320, 480], [20, 400, 172, 28], [100, 20, 81, 28], [115, 71, 178, 13],
      [60, 70, 80, 80], [250, 140, 60, 30], [115, 215, 178, 13], [250, 195, 60, 30],
    ]);
    expect(result.document.widgets[0].settings).toEqual({ label: 'BACKGROUND', data: asset.data, fit: 'stretch', opacity: 100 });
    expect(result.document.widgets.slice(2).map(({ settings }) => settings)).toMatchObject([
      { source: 'cpu', style: 'number', value: 24 }, { source: 'cpu', style: 'bar' },
      { source: 'cpu', style: 'ring' }, { source: 'gpu', unit: '', value: 41 },
      { source: 'memory', style: 'bar', value: 62 }, { source: 'memory', style: 'number' },
    ]);
    expect(result.warnings.join('\n')).toMatch(/Review this draft/);
    expect(result.warnings.join('\n')).toMatch(/Source colors are ignored/);
    expect(result.warnings.join('\n')).toMatch(/FONT, FONT_COLOR, ALIGN, ANCHOR/);
    expect(result.warnings.join('\n')).toMatch(/text bounds were estimated/);
    expect(validateLayout(result.document)).toEqual(result.document);
    expect(parseLayout(serializeLayout(result.document))).toEqual(result.document);
    expect(convert(representative, [asset])).toEqual(result);
  });

  it('uses selected PNG basenames and preserves image order, dimensions, explicit text bounds and input values', () => {
    const assets = [png(32, 16, 'ICON.PNG'), asset];
    const snapshot = structuredClone(assets);
    const result = convert(textOnly + `static_images:\n  FIRST: {PATH: folder/ICON.PNG, X: 7, Y: 8}\n  SECOND: {PATH: 'folder\\background.png', X: 0, Y: 0, WIDTH: 100, HEIGHT: 150}\n`, assets);
    expect(result.document.widgets.map(({ type, x, y, width, height }) => [type, x, y, width, height])).toEqual([
      ['image', 7, 8, 32, 16], ['image', 0, 0, 100, 150], ['text', 20, 400, 200, 50],
    ]);
    expect(assets).toEqual(snapshot);
    expect(result.document.palette).not.toBe(palette);
  });

  it('reports missing selected images and per-element backgrounds without pretending they were imported', () => {
    const result = convert(representative);
    expect(result.document.widgets).toHaveLength(7);
    expect(result.document.widgets.every(({ type }) => type !== 'image')).toBe(true);
    expect(result.warnings.join('\n')).toContain('missing image "background.png"');
    expect(result.warnings.join('\n')).toContain('missing background image "background.png"');
    expect(result.warnings.join('\n')).toContain('this image was omitted');
    expect(() => convert(`display: {DISPLAY_SIZE: '3.5"', DISPLAY_ORIENTATION: portrait}\nstatic_images: {BG: {PATH: missing.png}}`)).toThrow(/No supported drawable elements.*missing image/);
  });

  it('warns and omits unsupported enabled sensors and line graphs while ignoring hidden ones', () => {
    const input = textOnly + `STATS:\n  CPU:\n    FREQUENCY:\n      TEXT: {SHOW: True, X: 1, Y: 2}\n    PERCENTAGE:\n      LINE_GRAPH: {SHOW: True, X: 1, Y: 2, WIDTH: 10, HEIGHT: 10}\n      TEXT: {SHOW: False}\n  GPU:\n    MEMORY_PERCENT:\n      TEXT: {SHOW: True}\n  MEMORY:\n    VIRTUAL:\n      USED: {SHOW: True}\n  CUSTOM:\n    TEMPERATURE:\n      TEXT: {SHOW: True}\n`;
    const result = convert(input);
    expect(result.document.widgets).toHaveLength(1);
    const unsupported = result.warnings.filter((warning) => warning.includes('unsupported sensor mapping'));
    expect(unsupported).toHaveLength(5);
    expect(unsupported.join('\n')).toContain('STATS.CPU.FREQUENCY.TEXT');
    expect(unsupported.join('\n')).toContain('STATS.CPU.PERCENTAGE.LINE_GRAPH');
  });

  it('maps CPU and GPU temperature with source bounds and clamps deterministic samples', () => {
    const result = convert(textOnly + `STATS:\n  CPU:\n    TEMPERATURE:\n      GRAPH: {SHOW: True, X: 1, Y: 2, WIDTH: 50, HEIGHT: 10, MIN_VALUE: 70, MAX_VALUE: 90}\n  GPU:\n    TEMPERATURE:\n      TEXT: {SHOW: True, WIDTH: 60, HEIGHT: 30}\n`);
    expect(result.document.widgets.slice(1).map(({ settings }) => settings)).toMatchObject([
      { source: 'cpu-temperature', min: 70, max: 90, value: 70, unit: '°C' },
      { source: 'gpu-temperature', value: 48, unit: '°C' },
    ]);
  });

  it('warns about partial bitmap sizes and treats inherited object names as unsupported sensors', () => {
    const result = convert(textOnly + `static_images: {ICON: {PATH: background.png, WIDTH: 100}}\nSTATS: {toString: {TEXT: {SHOW: true}}}`, [asset]);
    expect(result.document.widgets).toHaveLength(2);
    expect(result.warnings.join('\n')).toContain('only one image dimension');
    expect(result.warnings.join('\n')).toContain('STATS.toString.TEXT: unsupported sensor mapping');
  });

  it('preserves landscape orientation and the verified upstream default size', () => {
    const result = convert(`display: {DISPLAY_ORIENTATION: landscape}\nstatic_text: {NOTE: {TEXT: Draft, X: 10, Y: 10, WIDTH: 100, HEIGHT: 30}}`);
    expect(result.document.canvas).toEqual({ width: 480, height: 320 });
    expect(result.warnings.join('\n')).toContain('DISPLAY_SIZE is absent');
    const wide = convert(`display: {DISPLAY_SIZE: '8"', DISPLAY_ORIENTATION: landscape}\nstatic_text: {NOTE: {TEXT: Draft}}`);
    expect(wide.document.canvas).toEqual({ width: 1280, height: 800 });
  });

  it.each(['https://example.com/image.png', 'file:///tmp/image.png', '/tmp/image.png', '../image.png', 'folder/../image.png', 'folder//image.png', 'C:\\image.png', '%2e%2e/image.png', '//host/image.png'])('rejects unsafe image references %s without attempting file or URL access', (reference) => {
    expect(() => convert(textOnly + `static_images: {BAD: {PATH: ${JSON.stringify(reference)}}}`)).toThrow(/safe relative image path|cannot contain/);
    expect(() => convert(textOnly + `STATS: {CPU: {FREQUENCY: {TEXT: {SHOW: True, BACKGROUND_IMAGE: ${JSON.stringify(reference)}}}}}`)).toThrow(/safe relative image path|cannot contain/);
  });

  it.each([
    ['aliases', textOnly + 'extra: &a {x: 1}\ncopy: *a', /anchors|aliases/],
    ['tags', textOnly + 'extra: !!str hi', /tags/],
    ['unknown tags', textOnly + 'extra: !execute hi', /Cannot parse/],
    ['prototype key', textOnly + '__proto__: {polluted: true}', /Unsafe YAML key/],
    ['constructor key', textOnly + 'extra: {constructor: value}', /Unsafe YAML key/],
    ['merge key', textOnly + 'extra: {<<: {x: 1}}', /Unsafe YAML key/],
    ['duplicate keys', textOnly + 'static_text: {}', /Cannot parse/],
    ['multiple documents', textOnly + '\n---\na: b', /Cannot parse/],
    ['numeric mapping key', textOnly + 'extra: {1: text}', /keys must be strings/],
    ['deep mappings', textOnly + 'extra: ' + '{n: '.repeat(20) + 'null' + '}'.repeat(20), /too complex/],
  ])('rejects %s', (_name, input, error) => { expect(() => convert(input)).toThrow(error); });

  it.each([
    ['fractional X', textOnly.replace('X: 20', 'X: 1.5'), /integer/],
    ['negative X', textOnly.replace('X: 20', 'X: -1'), /integer/],
    ['string Y', textOnly.replace('Y: 400', 'Y: "400"'), /integer/],
    ['overflow width', textOnly.replace('WIDTH: 200', 'WIDTH: 400'), /fit inside/],
    ['outside position', textOnly.replace('X: 20', 'X: 320'), /fit inside/],
    ['invalid display size', textOnly.replace('3.5"', '100"'), /unsupported size/],
    ['unknown orientation', textOnly.replace('portrait', 'reverse'), /portrait or landscape/],
    ['sequence section', textOnly.replace('  NOTE:', '  - NOTE:'), /expected a mapping/],
  ])('rejects malformed geometry and shapes: %s', (_name, input, error) => { expect(() => convert(input)).toThrow(error); });

  it('rejects string SHOW, invalid ranges and radial circles that extend outside the canvas', () => {
    const gauge = (fields: string) => textOnly + `STATS: {CPU: {PERCENTAGE: {RADIAL: {SHOW: true, X: 100, Y: 100, RADIUS: 40, ${fields}}}}}`;
    expect(() => convert(gauge('MIN_VALUE: 100, MAX_VALUE: 0'))).toThrow('MAX_VALUE must exceed');
    expect(() => convert(gauge('MAX_VALUE: .inf'))).toThrow('finite number');
    expect(() => convert(gauge('WIDTH: 50'))).toThrow('integer between 1 and 40');
    expect(() => convert(gauge('SHOW_UNIT: "true"'))).toThrow('expected a boolean');
    expect(() => convert(gauge('RADIUS: 120'))).toThrow('Cannot parse');
    expect(() => convert(gauge('WIDTH: 1').replace('X: 100', 'X: 10'))).toThrow('integer');
    expect(() => convert(gauge('WIDTH: 1').replace('SHOW: true', 'SHOW: "true"'))).toThrow('expected a boolean');
  });

  it('enforces theme bytes, widget counts, PNG bytes, asset names and dimensions', () => {
    const exact = textOnly + ' '.repeat(MAX_EXTERNAL_THEME_BYTES - Buffer.byteLength(textOnly));
    expect(convert(exact).document.widgets).toHaveLength(1);
    expect(() => convert(exact + ' ')).toThrow('at most 1 MB');
    expect(() => convert(textOnly + '# ' + '🌕'.repeat(MAX_EXTERNAL_THEME_BYTES / 4))).toThrow('at most 1 MB');
    const many = `display: {DISPLAY_SIZE: '3.5"', DISPLAY_ORIENTATION: portrait}\nstatic_text:\n` + Array.from({ length: MAX_EXTERNAL_WIDGETS + 1 }, (_, i) => `  T${i}: {TEXT: Test, WIDTH: 1, HEIGHT: 1}\n`).join('');
    expect(() => convert(many)).toThrow('at most 256 widgets');
    expect(() => convert(textOnly, [asset, { ...asset, name: 'BACKGROUND.PNG' }])).toThrow('duplicate image basename');
    expect(() => convert(textOnly, [{ ...asset, width: 319 }])).toThrow('dimensions differ');
    expect(() => convert(textOnly, [{ ...asset, name: '../background.png' }])).toThrow('cannot contain');
    expect(() => convert(textOnly, [{ ...asset, data: 'data:image/svg+xml;base64,PHN2Zz4=' }])).toThrow('select a PNG');
    expect(() => convert(textOnly, [{ ...asset, data: 'data:image/png;base64,' + 'A'.repeat(MAX_EXTERNAL_IMAGE_BYTES * 2) }])).toThrow('at most 512 KiB');
    expect(() => convert(textOnly, [{ ...asset, data: asset.data.replace('iVBOR', 'aVBOR') }])).toThrow('invalid PNG');
    expect(() => convert(textOnly, Array.from({ length: 65 }, (_, i) => ({ ...asset, name: `image${i}.png` })))).toThrow('at most 64');
    expect(() => convertExternalTheme(textOnly, [], { ...palette, primary: 'red' })).toThrow('$.palette.primary');
  });

  it.each(['\u0000SENSORPANEL', 'AIDA64 SensorPanel\nversion=1', '<?xml version="1.0"?><rslcd/>', '[SensorPanel]\nWidth=320', 'PK\u0003\u0004contents', '{"version": 1}', 'print("hello")'])('rejects unsupported sources with practical AIDA64 recreation guidance', (input) => {
    expect(() => convert(input)).toThrow(/Turing theme|AIDA64/);
    try { convert(input); } catch (error) { expect(String(error)).toContain('recreate the sensor widgets'); }
    expect(AIDA64_IMPORT_GUIDANCE).toContain('export or save its background as an image');
  });
});
