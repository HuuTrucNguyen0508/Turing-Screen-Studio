import { describe, expect, it } from 'vitest';
import { colorPresets, defaultStudioTheme, effectiveStudioPalette, paletteColorScheme, parseStudioTheme } from './studioTheme';

describe('Studio appearance preferences', () => {
  it('restores valid custom colors without adding them to a dashboard', () => {
    const custom = { mode: 'custom' as const, palette: { ...colorPresets[1], primary: '#aabbcc' } };
    const restored = parseStudioTheme(JSON.stringify(custom));
    expect(restored).toEqual(custom);
    const dashboard = { ...colorPresets[0] }, desktop = { ...colorPresets[2] };
    expect(effectiveStudioPalette(restored, dashboard, desktop)).toEqual(custom.palette);
    expect(effectiveStudioPalette({ ...restored, mode: 'desktop' }, dashboard, desktop)).toEqual(desktop);
    expect(effectiveStudioPalette({ ...restored, mode: 'desktop' }, dashboard, null)).toEqual(dashboard);
    expect(dashboard).toEqual(colorPresets[0]);
  });
  it('falls back when stored preferences are malformed or contain invalid colors', () => {
    for (const text of [null, '{', 'null', JSON.stringify({ mode: 'invalid', palette: colorPresets[0] }),
      JSON.stringify({ mode: 'custom', palette: { ...colorPresets[0], text: 'red' } }),
      JSON.stringify({ mode: 'custom', palette: { ...colorPresets[0], extra: '#abcdef' } })]) expect(parseStudioTheme(text)).toEqual(defaultStudioTheme());
    expect(paletteColorScheme(colorPresets[0])).toBe('dark');
    expect(paletteColorScheme(colorPresets[1])).toBe('light');
  });
});
