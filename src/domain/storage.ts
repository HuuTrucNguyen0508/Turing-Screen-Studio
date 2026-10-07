import sample from '../../public/storage-sample.json';
import type { StorageWidget } from './layout';

export const storageSample = sample;
export type StorageRow = { mount: string; aliases: string[]; device: string; filesystem: string; totalGiB: number | null; usedGiB: number | null; freeGiB: number | null; usedPercent: number | null; stale: boolean; errors: string[]; partial?: boolean; driveKind?: string };
export function storageRows(settings: StorageWidget['settings'], data: { mounts?: StorageRow[]; drives?: StorageRow[] } = storageSample): StorageRow[] {
  const rows = settings.grouping === 'drives' ? data.drives ?? [] : data.mounts ?? [];
  if (!settings.mounts) return rows;
  const seen = new Set<StorageRow>();
  return settings.mounts.flatMap((path) => {
    const row = rows.find((item) => item.mount === path || item.aliases.includes(path));
    if (row && seen.has(row)) return [];
    if (row) { seen.add(row); return [row]; }
    return [{ mount: path, aliases: [], device: '', filesystem: '', totalGiB: null, usedGiB: null, freeGiB: null, usedPercent: null, stale: true, errors: ['storage_selected_mount_unavailable'] }];
  });
}
export function storageRowName(row: StorageRow, filtered = false): string {
  if (!filtered) return [row.mount, ...row.aliases].join(' · ');
  const name = row.mount === '/' ? row.driveKind ?? 'System' : row.mount.split('/').at(-1) ?? row.mount;
  return name.toLowerCase() === 'nvme' ? 'NVMe partition' : name.toLowerCase() === 'games' ? 'Games partition' : name;
}
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
