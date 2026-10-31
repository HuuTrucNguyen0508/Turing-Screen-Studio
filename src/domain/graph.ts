import { formatGaugeNumber } from './widgets';
import { cardKicker, cardPadding, sensorShortLabels } from './cardText';
import { formatReading, trendHistory, trendRange, trendSegments, trendState, trendUnit } from './trend';
import type { TrendPoint, TrendSource } from './trend';

export const GRAPH_SERIES_ROLES = ['primary', 'secondary'] as const;
/** Area tint, mixed into the card surface so overlapping series stay opaque in SVG and PIL. */
export const GRAPH_AREA_MIX = .24;

export function demoGraphHistory(source: TrendSource): number[] {
  const profiles: Record<TrendSource, [number, number, number]> = {
    cpu: [24, 12, 0], gpu: [18, 10, 12], memory: [39, 3, 6], disk: [45, 1, 18],
    'network-down': [640, 450, 0], 'network-up': [90, 65, 12],
    'cpu-temperature': [42, 4, 0], 'gpu-temperature': [55, 6, 12],
  };
  const [base, amplitude, offset] = profiles[source];
  const anchors = [-3, 1, 5, 2, -2, -4, -3];
  return Array.from({ length: 120 }, (_, index) => {
    const slot = (index + offset) % 120;
    const segment = Math.floor(slot / 20), t = slot % 20;
    const blend = t * t * (60 - 2 * t) / 8000;
    const wave = anchors[segment] + (anchors[segment + 1] - anchors[segment]) * blend;
    return Math.floor((base + amplitude * wave / 10) * 10 + .5) / 10;
  });
}

export function graphRange(source: TrendSource, history: readonly (number | null)[]): [number, number] {
  const numbers = history.filter((value): value is number => value !== null);
  if (!source.endsWith('-temperature')) return trendRange(source, history);
  if (!numbers.length) return [0, 100];
  const min = Math.min(...numbers), max = Math.max(...numbers);
  const padding = Math.max(2, Math.ceil((max - min) * .15));
  return [Math.floor(min - padding), Math.ceil(max + padding)];
}

export function graphGeometry(width: number, height: number) {
  const padding = cardPadding(width);
  const top = 144, bottom = height - 48;
  return { left: padding, right: width - padding, top, bottom, middle: Math.floor((top + bottom) / 2),
    rangeY: 130, captionY: height - 20, showChart: width >= 160 && bottom - top >= 32 };
}

/** Matching units share one axis, so download and upload compare directly. */
export function graphRanges(sources: readonly TrendSource[], histories: readonly (number | null)[][]): { shared: boolean; ranges: [number, number][] } {
  if (new Set(sources.map(trendUnit)).size === 1) {
    const range = graphRange(sources[0], histories.flat());
    return { shared: true, ranges: sources.map(() => range) };
  }
  return { shared: false, ranges: sources.map((source, index) => graphRange(source, histories[index])) };
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
    const lastValue = histories[index].at(-1) ?? null;
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
      lines: segments.filter((segment) => segment.length > 1),
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
