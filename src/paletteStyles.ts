import type { CSSProperties } from 'react';
import type { Palette, Widget } from './domain/layout';

export function paletteStyle(palette: Palette): CSSProperties {
  return Object.fromEntries(Object.entries(palette).filter(([key]) => key !== 'name').map(([key, value]) => [`--${key}`, value])) as CSSProperties;
}

export function widgetColorStyle(widget: Widget): CSSProperties {
  return {
    ...Object.fromEntries(Object.entries(widget.colors ?? {}).map(([key, value]) => [`--${key}`, value])),
    ...(widget.type === 'image' ? { '--image-background': widget.colors?.surface ?? 'transparent', '--image-border': widget.colors?.outline ? `1px solid ${widget.colors.outline}` : '0' } : {}),
  } as CSSProperties;
}

export function elementColor(color: string): string {
  return color.startsWith('#') ? color : `var(--${color})`;
}
