import sample from '../../public/storage-sample.json';

export const storageSample = sample;
export function storageGeometry(width: number, height: number, style: 'bars' | 'table') {
  const table = style === 'table' && width >= 460;
  const start = table ? 96 : 80;
  const stride = table ? 46 : style === 'bars' ? 70 : 62;
  return { table, start, stride, capacity: Math.max(0, Math.floor((height - start - 38) / stride)) };
}
export function storageSize(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const unit = value >= 1024 ? 'TiB' : 'GiB';
  const size = unit === 'TiB' ? value / 1024 : value;
  return `${Math.floor(size * 10 + .5) / 10} ${unit}`;
}
export function storageShort(value: string, characters: number): string {
  value = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return value.length <= characters ? value : value.slice(0, Math.max(0, characters - 1)) + '…';
}
