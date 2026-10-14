import { demoTrendHistory, formatReading } from './trend';
import type { TrendSource } from './trend';

export const LIST_MAX_ROWS = 6;

export const sensorShortLabels: Record<TrendSource, string> = {
  cpu: 'CPU', gpu: 'GPU', memory: 'Memory', disk: 'Disk', 'network-down': 'Download',
  'network-up': 'Upload', 'cpu-temperature': 'CPU temp', 'gpu-temperature': 'GPU temp',
};

/** A new row reads like the graph's demo legend, so previews of both cards agree. */
export function listSampleRow(source: TrendSource): { source: TrendSource; label: string; value: string; unit: string } {
  return { source, label: sensorShortLabels[source], ...formatReading(source, demoTrendHistory(source).at(-1) ?? null) };
}

/** Bar progress for a row, or null when the row has no bar. Temperatures span 0 to 100 °C. */
export function listFraction(source: TrendSource, value: string): number | null {
  if (source.startsWith('network-')) return null;
  const number = /^ *-?[0-9]+(\.[0-9]+)? *$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number / 100)) : 0;
}

export function listBarRole(source: TrendSource): 'primary' | 'secondary' {
  return source.endsWith('-temperature') ? 'secondary' : 'primary';
}

export function shortenText(text: string, capacity: number): string {
  const characters = [...text];
  return characters.length > capacity ? `${characters.slice(0, Math.max(0, capacity - 1)).join('')}…` : text;
}

/** The 15 px card label, shortened like the trend metric's. */
export function cardKicker(label: string, width: number): string {
  return shortenText(label, Math.max(1, Math.floor((width - 2 * Math.min(29, Math.floor(width / 6))) / 8)));
}

export interface ListRowLayout { label: string; value: string; unit: string; baseline: number; barY: number | null; fraction: number | null }

/** Shared row metrics. Rows past the readable capacity are omitted rather than overlapped. */
export function listLayout(width: number, height: number, label: string, rows: readonly { source: TrendSource; label: string; value: string; unit: string }[], bars: boolean) {
  const padding = Math.min(29, Math.floor(width / 6));
  const top = label ? 60 : 24;
  const available = Math.max(0, height - top - 20);
  const visible = Math.min(rows.length, Math.floor(available / 24));
  const stride = Math.min(88, Math.floor(available / Math.max(1, visible)));
  const valueSize = Math.max(12, Math.min(28, Math.floor(stride * .42)));
  const labelSize = Math.max(12, Math.min(18, Math.floor(stride * .3)));
  const unitSize = Math.max(11, Math.floor(valueSize * .5));
  const showBars = bars && stride >= 44;
  const layouts = rows.slice(0, visible).map((row, index): ListRowLayout => {
    const rowTop = top + index * stride;
    const fraction = showBars ? listFraction(row.source, row.value) : null;
    const valueWidth = [...row.value].length * valueSize * .6 + 4 + [...row.unit].length * unitSize * .55;
    const capacity = Math.max(1, Math.floor((width - 2 * padding - valueWidth - 12) / (labelSize * .55)));
    return {
      label: shortenText(row.label.trim() || sensorShortLabels[row.source], capacity),
      value: row.value, unit: row.unit,
      baseline: showBars ? rowTop + stride - 26 : rowTop + Math.floor(stride / 2) + Math.floor(valueSize * .35),
      barY: fraction === null ? null : rowTop + stride - 16, fraction,
    };
  });
  return { padding, top, stride, valueSize, labelSize, unitSize, kicker: cardKicker(label, width), rows: layouts };
}
