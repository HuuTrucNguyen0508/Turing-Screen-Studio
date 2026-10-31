import type { TrendSource } from './trend';

export const cardPadding = (width: number): number => Math.min(29, Math.floor(width / 6));

export const sensorShortLabels: Record<TrendSource, string> = {
  cpu: 'CPU', gpu: 'GPU', memory: 'Memory', disk: 'Disk', 'network-down': 'Download',
  'network-up': 'Upload', 'cpu-temperature': 'CPU temp', 'gpu-temperature': 'GPU temp',
};

export function shortenText(text: string, capacity: number): string {
  const characters = [...text];
  return characters.length > capacity ? `${characters.slice(0, Math.max(0, capacity - 1)).join('')}…` : text;
}

/** The 15 px card label, shortened like the trend metric's. */
export function cardKicker(label: string, width: number): string {
  return shortenText(label, Math.max(1, Math.floor((width - 2 * cardPadding(width)) / 8)));
}
