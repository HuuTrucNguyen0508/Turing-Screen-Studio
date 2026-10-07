import type { Palette } from './layout';
import { paletteColorKeys } from './layout';

export const studioThemeModes = ['dashboard', 'desktop', 'custom'] as const;
export type StudioThemeMode = typeof studioThemeModes[number];
export interface StudioThemePreference { mode: StudioThemeMode; palette: Palette }
export const colorPresets: readonly Palette[] = [
  { name: 'Studio dark', background: '#0a0f0f', surface: '#131b1b', surfaceRaised: '#192121', text: '#dce8e7', muted: '#a2adad', primary: '#9bd0d1', secondary: '#b0cccc', outline: '#3f4a4a' },
  { name: 'Paper', background: '#f3f5f7', surface: '#ffffff', surfaceRaised: '#e9eef3', text: '#172b3a', muted: '#536776', primary: '#285e81', secondary: '#526c92', outline: '#bac6cf' },
  { name: 'Midnight', background: '#101726', surface: '#192337', surfaceRaised: '#26324a', text: '#e6edf7', muted: '#a6b5cb', primary: '#9bbef2', secondary: '#c5b7e9', outline: '#46546c' },
];

export function defaultStudioTheme(): StudioThemePreference {
  return { mode: 'dashboard', palette: { ...colorPresets[0] } };
}

/** Local appearance preferences are separate from the saved layout contract. */
export function parseStudioTheme(text: string | null): StudioThemePreference {
  try {
    const raw = JSON.parse(text ?? 'null');
    if (!raw || !studioThemeModes.includes(raw.mode) || !raw.palette || typeof raw.palette.name !== 'string'
      || Object.keys(raw.palette).length !== paletteColorKeys.length + 1
      || !paletteColorKeys.every((key) => typeof raw.palette[key] === 'string' && /^#[0-9a-f]{6}$/i.test(raw.palette[key]))) return defaultStudioTheme();
    return { mode: raw.mode, palette: { name: raw.palette.name, ...Object.fromEntries(paletteColorKeys.map((key) => [key, raw.palette[key]])) } as Palette };
  } catch { return defaultStudioTheme(); }
}

export function effectiveStudioPalette(preference: StudioThemePreference, dashboard: Palette, desktop: Palette | null): Palette {
  return preference.mode === 'custom' ? preference.palette : preference.mode === 'desktop' && desktop ? desktop : dashboard;
}

export function paletteColorScheme(palette: Palette): 'light' | 'dark' {
  const channels = [1, 3, 5].map((offset) => parseInt(palette.background.slice(offset, offset + 2), 16) / 255);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 > .5 ? 'light' : 'dark';
}
