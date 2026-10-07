import type { MetricWidget } from './domain/layout';
import { dashboardGeometry, dashboardRows, shortDashboardText as short } from './domain/dashboardData';
import './dashboard-styles.css';

const providers: Record<string, string> = { 'codex-pro': 'Codex Pro', codex: 'Codex', claudeAgent: 'Claude', cursor: 'Cursor' };
const statuses: Record<string, string> = { running: 'Working', waiting_approval: 'Needs approval', waiting_input: 'Needs input', waiting: 'Waiting' };

export default function DashboardContent({ widget }: { widget: MetricWidget }) {
  const { width: w, height: h, settings } = widget;
  const data = dashboardRows(settings.detail);
  const { padding: p, top, stride, capacity, available } = dashboardGeometry(w, h, settings.source!);
  const text = (x: number, y: number, value: string, size = 13, role = 'muted', mono = false, end = false) =>
    <text x={x} y={y} fill={`var(--${role})`} fontSize={size} fontFamily={mono ? 'Studio Mono, monospace' : 'Studio Roboto, sans-serif'} textAnchor={end ? 'end' : 'start'}>{value}</text>;
  if (settings.source === 't3-threads') {
    const compact = h < 132;
    const count = data.working === null ? '—' : String(data.working);
    const size = Math.max(12, Math.min(compact ? 36 : 48, Math.floor((available - (data.working === null ? 0 : 88)) / Math.max(1, count.length * .6))));
    const overflow = data.threads.length > capacity;
    const shown = data.threads.slice(0, overflow ? Math.max(0, capacity - 1) : capacity);
    return <svg className="local-dashboard" width={w} height={h} role="img" aria-label={`${settings.label}, ${count} working. ${data.note}`} data-dashboard-source="t3-threads">
      {text(p, compact ? 25 : 40, short(settings.label, available, 15), 15)}
      {text(p, compact ? 76 : 98, count, size, data.working === null ? 'muted' : 'primary', true)}
      {data.working !== null && text(p + count.length * size * .6 + 8, compact ? 76 : 98, 'working', 20)}
      {!compact && text(p, 124, short(data.note || 'Activity unavailable', available, 13))}
      {capacity > 0 && <line x1={p} x2={w - p} y1="140" y2="140" stroke="var(--outline)" />}
      {shown.map((row, index) => <g key={index} data-thread-row="true">
        {text(p, top + index * stride, short(row.title, available, 16), 16, 'text')}
        <circle cx={p + 4} cy={top + index * stride + 14} r="3" stroke={row.status === 'running' ? 'var(--primary)' : 'var(--muted)'} fill={row.status === 'running' ? 'var(--primary)' : 'none'} />
        {text(p + 14, top + index * stride + 18, statuses[row.status] ?? 'Waiting')}
        {w >= 230 && text(w - p, top + index * stride + 18, short(providers[row.provider] ?? row.provider, 78, 12, true), 12, 'secondary', true, true)}
      </g>)}
      {overflow && capacity > 0 && text(p, top + shown.length * stride, 'More threads in T3', 12)}
      {data.working === 0 && data.threads.length === 0 && capacity > 0 && text(p, top, short('No threads working', available, 14), 14)}
    </svg>;
  }
  return <svg className="local-dashboard" width={w} height={h} role="img" aria-label={`${settings.label}. ${data.note}`} data-dashboard-source="game-resources">
    {text(p, 40, short(settings.label, Math.max(1, available - 62), 15), 15)}
    {w >= 230 && text(w - p, 40, data.note.startsWith('Sample') ? 'Sample' : 'Estimated', 13, 'muted', false, true)}
    {capacity === 0 ? text(p, 76, short('Enlarge card to show timers', available, 13)) : data.games.slice(0, capacity).map((row, index) => {
      const y = top + stride * index;
      const count = row.current === null ? '—' : String(row.current);
      const cap = '/' + (row.capacity === null ? '—' : row.capacity);
      const capWidth = cap.length * 14 * .6;
      const numberX = w - p - capWidth - 2;
      const nameWidth = Math.max(1, numberX - count.length * 24 * .6 - p - 12);
      const fraction = row.current !== null && row.capacity !== null && row.capacity > 0 ? Math.min(1, row.current / row.capacity) : 0;
      const full = stride >= 72;
      const baseline = y + (full ? 34 : 24);
      const barY = y + (full ? 44 : 32);
      return <g key={index} data-game-row="true">
        {text(p, baseline, short(row.name, nameWidth, 16), 16, 'text')}
        {text(numberX, baseline, count, 24, row.current === null ? 'muted' : 'secondary', true, true)}
        {text(w - p, baseline, cap, 14, 'muted', true, true)}
        <rect x={p} y={barY} width={available} height="4" rx="2" fill="var(--outline)" />
        {fraction > 0 && <rect x={p} y={barY} width={Math.round(available * fraction)} height="4" rx="2" fill="var(--secondary)" />}
        {full && text(p, y + 66, short(row.remaining || 'Timer unavailable', available - (row.age ? 80 : 0), 13))}
        {full && row.age && text(w - p, y + 66, row.age, 12, 'muted', false, true)}
      </g>;
    })}
    {capacity > 0 && data.games.length === 0 && text(p, 92, short('Set counts in Game timers', available, 14), 14)}
  </svg>;
}
