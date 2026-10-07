/** Observation slots, newest last. Nulls retain their slot and break the line. */
export const TREND_CAPACITY = 120;
export const trendSources = ['cpu', 'gpu', 'memory', 'disk', 'network-down', 'network-up', 'cpu-temperature', 'gpu-temperature'] as const;
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

export function trendChart(source: string, input: unknown, width: number, height: number) {
  const history = trendHistory(input);
  const [min, max] = trendRange(source, history);
  const geometry = trendGeometry(width, height);
  const segments: TrendPoint[][] = [];
  let segment: TrendPoint[] = [];
  const flush = () => { if (segment.length) segments.push(segment); segment = []; };
  const scale = Math.max(Math.abs(min), Math.abs(max), 1);
  history.forEach((value, index) => {
    if (value === null) { flush(); return; }
    const fraction = Math.max(0, Math.min(1, (value / scale - min / scale) / (max / scale - min / scale)));
    segment.push({
      x: Math.round(geometry.left + (TREND_CAPACITY - history.length + index) * (geometry.right - geometry.left) / (TREND_CAPACITY - 1)),
      y: Math.round(geometry.bottom - fraction * (geometry.bottom - geometry.top)),
    });
  });
  flush();
  const count = history.filter((value) => value !== null).length;
  const state = count === 0 ? 'No history yet' : segments.some((points) => points.length > 1) ? '' : 'Collecting history';
  return { ...geometry, min, max, segments, count, state };
}

export function trendCaption(demo: boolean): string {
  return `Last 120 readings · ${demo ? 'Demo' : 'Observed'}`;
}
