import type { StorageWidget } from './domain/layout';
import { storageGeometry, storageRows, storageRowName, storageShort, storageSize } from './domain/storage';
import './storage-styles.css';

export default function StorageContent({ widget }: { widget: StorageWidget }) {
  const { width: w, height: h, settings } = widget;
  const { table, start, stride, capacity } = storageGeometry(w, h, settings.style);
  const mounts = storageRows(settings);
  const drives = settings.grouping === 'drives';
  const noun = drives ? 'drives' : 'filesystems';
  const rows = mounts.slice(0, capacity);
  const hidden = mounts.length - rows.length;
  const p = 24, available = Math.max(0, w - 2 * p);
  return <div className="storage-content" data-storage-style={settings.style}>
    <svg width={w} height={h} role="img" aria-label={`${settings.label}: ${mounts.length} sample ${noun}`}>
      <text x={p} y={34} className="storage-label">{storageShort(settings.label, Math.max(1, Math.floor(available / 8)))}</text>
      <text x={p} y={56} className="storage-muted">{mounts.length} {noun} · sample data</text>
      {table && <g className="storage-muted storage-column"><text x={p} y={83}>{drives ? 'Drive' : 'Mount'}</text><text x={w * .63} y={83} textAnchor="end">Used / total</text><text x={w * .82} y={83} textAnchor="end">Free</text><text x={w - p} y={83} textAnchor="end">Used</text></g>}
      {rows.map((row, index) => {
        const y = start + index * stride;
        const path = storageRowName(row, Boolean(settings.mounts));
        const valid = typeof row.usedPercent === 'number' && Number.isFinite(row.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100;
        const percent = valid ? `${Math.round(row.usedPercent!)}%${row.partial ? '+' : ''}` : '—';
        return <g key={`${row.device}:${row.mount}`}>
          <title>{path} · {row.device} · {row.filesystem}</title>
          <text x={p} y={y + 12} className="storage-path">{storageShort(path, Math.max(1, Math.floor((table ? w * .35 - p : available - 50) / 8)))}</text>
          {table ? <><text x={w * .63} y={y + 12} textAnchor="end" className="storage-number">{storageSize(row.usedGiB)}{row.partial ? '+' : ''} / {storageSize(row.totalGiB)}</text><text x={w * .82} y={y + 12} textAnchor="end" className="storage-number">{storageSize(row.freeGiB)}</text><text x={w - p} y={y + 12} textAnchor="end" className="storage-percent">{percent}</text><line x1={p} x2={w - p} y1={y + 28} y2={y + 28} className="storage-divider" /></> : <>
            <text x={w - p} y={y + 12} textAnchor="end" className="storage-percent">{percent}</text>
            <text x={p} y={y + 33} className="storage-number">{storageShort(`${storageSize(row.usedGiB)}${row.partial && row.usedGiB !== null ? '+' : ''} / ${storageSize(row.totalGiB)}${drives ? '' : ` · ${storageSize(row.freeGiB)} free`}`, Math.max(1, Math.floor(available / 6.7)))}</text>
            {settings.style === 'bars' && <><rect x={p} y={y + 45} width={available} height={6} rx={3} className="storage-track" />{valid && <rect x={p} y={y + 45} width={available * row.usedPercent! / 100} height={6} rx={3} className="storage-fill" />}</>}
          </>}
        </g>;
      })}
      <text x={p} y={h - 19} className="storage-muted">{storageShort(hidden ? `+${hidden} ${noun} · enlarge card` : drives ? '+ Mounted usage only · GiB / TiB' : 'Shared mounts grouped · GiB / TiB', Math.max(1, Math.floor(available / 6.7)))}</text>
    </svg>
  </div>;
}
