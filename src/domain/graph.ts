import { formatGaugeNumber } from './widgets';
import { cardKicker, sensorShortLabels } from './list';
import { formatReading, trendHistory, trendRange, trendSegments, trendState, trendUnit } from './trend';
import type { TrendPoint, TrendSource } from './trend';

export const GRAPH_SERIES_ROLES = ['primary', 'secondary'] as const;
/** Area tint, mixed into the card surface so overlapping series stay opaque in SVG and PIL. */
export const GRAPH_AREA_MIX = .24;

export function graphGeometry(width: number, height: number) {
  const padding = Math.min(29, Math.floor(width / 6));
  const top = 124, bottom = height - 48;
  return { left: padding, right: width - padding, top, bottom, middle: Math.floor((top + bottom) / 2),
    captionY: height - 20, showChart: width >= 160 && bottom - top >= 32 };
}

/** Matching units share one axis, so download and upload compare directly. */
export function graphRanges(sources: readonly TrendSource[], histories: readonly (number | null)[][]): { shared: boolean; ranges: [number, number][] } {
  if (new Set(sources.map(trendUnit)).size === 1) {
    const range = trendRange(sources[0], histories.flat());
    return { shared: true, ranges: sources.map(() => range) };
  }
  return { shared: false, ranges: sources.map((source, index) => trendRange(source, histories[index])) };
}

/**
 * Split a polyline into dashes measured along its length. Theme palettes often
 * make primary and secondary nearly equal, so the second series needs a shape.
 */
export function dashedLine(points: readonly TrendPoint[], dash = 8, gap = 5): TrendPoint[][] {
  const dashes: TrendPoint[][] = [];
  let current: TrendPoint[] = points.length ? [points[0]] : [];
  let phase = 0;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    const length = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    let travelled = 0;
    while (travelled < length) {
      const drawing = phase < dash;
      const boundary = drawing ? dash : dash + gap;
      const reached = boundary - phase <= length - travelled;
      if (reached) { travelled += boundary - phase; phase = boundary; } else { phase += length - travelled; travelled = length; }
      const point = { x: Math.round(a.x + (b.x - a.x) * travelled / length), y: Math.round(a.y + (b.y - a.y) * travelled / length) };
      if (drawing) current.push(point);
      if (drawing && reached) { if (current.length > 1) dashes.push(current); current = []; }
      if (!drawing && reached) { phase = 0; current = [point]; }
    }
  }
  if (current.length > 1) dashes.push(current);
  return dashes;
}

export interface GraphSeries {
  source: TrendSource; role: typeof GRAPH_SERIES_ROLES[number]; name: string; primary: boolean;
  segments: TrendPoint[][]; lines: TrendPoint[][]; last: TrendPoint | null; reading: { value: string; unit: string };
  legend: { x: number; nameY: number | null; valueY: number; valueSize: number; unitSize: number };
}

export function graphChart(label: string, sources: readonly TrendSource[], inputs: readonly unknown[], width: number, height: number) {
  const geometry = graphGeometry(width, height);
  const histories = sources.map((_, index) => trendHistory(inputs[index]));
  const { shared, ranges } = graphRanges(sources, histories);
  const series = sources.map((source, index): GraphSeries => {
    const segments = trendSegments(histories[index], ranges[index], geometry);
    const lastValue = [...histories[index]].reverse().find((value) => value !== null) ?? null;
    const reading = formatReading(source, lastValue);
    const column = Math.floor((geometry.right - geometry.left) / sources.length);
    // One series reads like a trend metric; two share the header as legend columns.
    const legend = sources.length === 1
      ? { x: geometry.left, nameY: null, valueY: 92, unitSize: 16,
        valueSize: Math.max(12, Math.min(36, Math.floor(column / Math.max(1, reading.value.length * .64 + reading.unit.length * .3)))) }
      : { x: geometry.left + index * column, nameY: 68, valueY: 104, unitSize: 14,
        valueSize: Math.max(12, Math.min(28, Math.floor((column - 8) / Math.max(1, reading.value.length * .64 + reading.unit.length * .3 + .5)))) };
    const primary = index === 0;
    return { source, role: GRAPH_SERIES_ROLES[index], name: sensorShortLabels[source], primary, segments,
      lines: segments.filter((segment) => segment.length > 1).flatMap((segment) => primary ? [segment] : dashedLine(segment)),
      last: histories[index].at(-1) === null || !segments.length ? null : segments.at(-1)!.at(-1)!,
      reading, legend };
  });
  const scale = (index: number) => `${formatGaugeNumber(ranges[index][0])}-${formatGaugeNumber(ranges[index][1])} ${trendUnit(sources[index])}`.trim();
  const range = shared ? scale(0) : `${scale(0)} · ${scale(1)}`;
  return { ...geometry, kicker: cardKicker(label, width), series, range, state: trendState(histories, series.flatMap((entry) => entry.segments)) };
}

export function graphArea(points: readonly TrendPoint[], bottom: number): TrendPoint[] {
  return [{ x: points[0].x, y: bottom }, ...points, { x: points.at(-1)!.x, y: bottom }];
}
