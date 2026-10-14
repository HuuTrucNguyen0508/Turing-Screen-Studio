/** Observation slots, newest last. Nulls retain their slot and break the line. */
export const TREND_CAPACITY = 120;
export const trendSources = ['cpu', 'gpu', 'memory', 'disk', 'network-down', 'network-up', 'cpu-temperature', 'gpu-temperature'] as const;
export type TrendSource = typeof trendSources[number];
const percentageSources = ['sample', 'cpu', 'gpu', 'memory', 'disk'];

export function trendHistory(input: unknown): (number | null)[] {
  return Array.isArray(input) ? input.slice(-TREND_CAPACITY).map((value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null) : [];
}

/** Explicit demo mode only; an unsupported source has no invented observations. */
export function demoTrendHistory(source = 'sample'): (number | null)[] {
  const profiles: Record<string, [number, number]> = {
    sample: [24, 12], cpu: [24, 12], gpu: [18, 10], memory: [39, 3], disk: [45, 1],
    'network-down': [640, 450], 'network-up': [90, 65],
    'cpu-temperature': [42, 4], 'gpu-temperature': [55, 6],
  };
  const profile = profiles[source];
  if (!profile) return [];
  return Array.from({ length: TREND_CAPACITY }, (_, index) => {
    // A fixed integer wave gives Python and JS identical demo samples.
    const wave = (index * 7 % 31) / 30;
    return Math.floor((profile[0] + profile[1] * (wave - .5)) * 10 + .5) / 10;
  });
}

export function trendRange(source: string, history: readonly (number | null)[]): [number, number] {
  if (percentageSources.includes(source)) return [0, 100];
  const numbers = history.filter((value): value is number => value !== null);
  return [Math.min(0, ...numbers), Math.max(1, ...numbers)];
}

export function trendUnit(source: string): string {
  return percentageSources.includes(source) ? '%' : source.startsWith('network-') ? 'KB/s'
    : source.endsWith('-temperature') ? '°C' : '';
}

export function trendGeometry(width: number, height: number) {
  const padding = Math.min(29, Math.floor(width / 6));
  return { left: padding, right: width - padding, top: 120, bottom: height - 66,
    captionY: height - 29, showChart: width >= 160 && height >= 216 };
}

export interface TrendPoint { x: number; y: number }
export interface ChartBox { left: number; right: number; top: number; bottom: number }

/** Plot history into a box. Slot positions are fixed, so a short history starts at the right. */
export function trendSegments(history: readonly (number | null)[], [min, max]: readonly [number, number], box: ChartBox): TrendPoint[][] {
  const segments: TrendPoint[][] = [];
  let segment: TrendPoint[] = [];
  const flush = () => { if (segment.length) segments.push(segment); segment = []; };
  const scale = Math.max(Math.abs(min), Math.abs(max), 1);
  history.forEach((value, index) => {
    if (value === null) { flush(); return; }
    const fraction = Math.max(0, Math.min(1, (value / scale - min / scale) / (max / scale - min / scale)));
    segment.push({
      x: Math.round(box.left + (TREND_CAPACITY - history.length + index) * (box.right - box.left) / (TREND_CAPACITY - 1)),
      y: Math.round(box.bottom - fraction * (box.bottom - box.top)),
    });
  });
  flush();
  return segments;
}

export function trendState(histories: readonly (readonly (number | null)[])[], segments: readonly TrendPoint[][]): string {
  return histories.every((history) => history.every((value) => value === null)) ? 'No history yet'
    : segments.some((points) => points.length > 1) ? '' : 'Collecting history';
}

export function trendChart(source: string, input: unknown, width: number, height: number) {
  const history = trendHistory(input);
  const [min, max] = trendRange(source, history);
  const geometry = trendGeometry(width, height);
  const segments = trendSegments(history, [min, max], geometry);
  const count = history.filter((value) => value !== null).length;
  return { ...geometry, min, max, segments, count, state: trendState([history], segments) };
}

/** Rounds half up in both languages; toFixed and Python formatting disagree on ties. */
export function fixedNumber(value: number, places: number): string {
  const factor = 10 ** places;
  return (Math.floor(value * factor + .5) / factor).toFixed(places);
}

/** Display a sensor number the way the panel shows live rows and graph legends. */
export function formatReading(source: string, value: number | null): { value: string; unit: string } {
  const unit = trendUnit(source);
  if (value === null || !Number.isFinite(value)) return { value: '—', unit };
  if (unit === 'KB/s' && value >= 1024) return { value: fixedNumber(value / 1024, 1), unit: 'MB/s' };
  return { value: fixedNumber(value, 0), unit };
}

export function trendCaption(demo: boolean): string {
  return `Last 120 readings · ${demo ? 'Demo' : 'Observed'}`;
}
