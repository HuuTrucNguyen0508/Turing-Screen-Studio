import type { MetricWidget } from './domain/layout';
import { usageSummaryRows } from './domain/usageSummary';

const short = (text: string, width: number, size: number) => {
  const capacity = Math.max(1, Math.floor(width / (size * .55)));
  return text.length <= capacity ? text : text.slice(0, capacity - 1) + '…';
};

export default function UsageSummaryContent({ widget }: { widget: MetricWidget }) {
  const { width: w, height: h, settings } = widget;
  const { note, providers, quotas } = usageSummaryRows(settings.detail);
  const p = 28;
  const caption = note.replace(' · Last 30 days', '').replace('Last 30 days · ', '').split(' · ');
  const state = caption.length > 1 ? caption.pop()! : '';
  if (settings.source === 'usage-limits') {
    const labelX = Math.floor(w * .128), barX = Math.floor(w * .222), barEnd = Math.floor(w * .639);
    const valueX = Math.floor(w * .712), captionX = Math.floor(w * .75);
    const stride = Math.min(60, Math.max(1, Math.floor((h - 100) / 4)));
    return <svg className="usage-summary" width={w} height={h} aria-hidden="true">
      <text className="summary-label" x={p} y="40">{settings.label} · Usage left</text>
      {quotas.map((row, index) => {
        const top = 64 + stride * index;
        const group = index === 0 || quotas[index - 1].provider !== row.provider;
        return <g key={`${row.provider}-${row.window}`}>
          {group && index > 0 && <line x1={p} x2={w - p} y1={top} y2={top} className="summary-rule" />}
          {group && <text className="summary-provider" x={p} y={top + 38}>{row.provider}</text>}
          <text className="summary-label" x={labelX} y={top + 37}>{row.window}</text>
          <rect x={barX} y={top + 27} width={Math.max(0, barEnd - barX)} height="8" rx="4" className="summary-track" />
          {row.remainingPercent !== null && row.remainingPercent > 0 && <rect x={barX} y={top + 27} width={Math.floor((barEnd - barX) * row.remainingPercent / 100 + .5)} height="8" rx="4" className="summary-fill" />}
          <text className={`summary-percent${row.remainingPercent === null ? ' unknown' : ''}`} x={valueX} y={top + 40} textAnchor="end">{row.remainingPercent === null ? '—' : Math.floor(row.remainingPercent + .5)}</text>
          {row.remainingPercent !== null && <text className="summary-caption" x={valueX + 4} y={top + 40}>%</text>}
          <text className="summary-caption" x={captionX} y={top + 29}>{short(row.reset, w - p - captionX, 14)}</text>
          <text className="summary-state" x={captionX} y={top + 47}>{short(row.state, w - p - captionX, 12)}</text>
        </g>;
      })}
      <text className="summary-footnote" x={p} y={h - 20}>{short(`${note}. Missing data is not zero.`, w - p * 2, 12)}</text>
    </svg>;
  }
  const unit = settings.value === '—' ? '' : settings.unit;
  const unitWidth = unit.length * 22 * .55;
  const size = Math.max(12, Math.min(56, Math.floor((w - p * 2 - unitWidth - 8) / Math.max(1, settings.value.length * .6))));
  const amounts = providers.map(row => {
    const value = Number.parseFloat(row.value.replace(/,/g, ''));
    return Number.isFinite(value) ? value * (row.value.includes('B') ? 1e9 : row.value.includes('M') ? 1e6 : row.value.includes('K') ? 1e3 : 1) : 0;
  });
  const total = amounts.reduce((sum, n) => sum + n, 0);
  const barX = 120, barEnd = Math.max(barX, w - 140);
  return <svg className="usage-summary" width={w} height={h} aria-hidden="true">
    <text className="summary-label" x={p} y="40">{settings.label}</text>
    <text className="summary-label" x={w - p} y="40" textAnchor="end">Last 30 days</text>
    <text className={`summary-total${settings.value === '—' ? ' unknown' : ''}`} x={p} y="112" fontSize={size}>{settings.value}</text>
    <text className="summary-unit" x={p + settings.value.length * size * .6 + 8} y="112">{unit}</text>
    <text className="summary-state" x={p} y="138">{short(caption.join(' · '), w - p * 2, 12)}</text>
    <text className="summary-state" x={p} y="156">{short(state, w - p * 2, 12)}</text>
    <line x1={p} x2={w - p} y1="166" y2="166" className="summary-rule" />
    {providers.map((row, index) => <g key={row.provider}>
      <text className="summary-provider" x={p} y={202 + index * 36}>{row.provider}</text>
      <rect x={barX} y={193 + index * 36} width={barEnd - barX} height="4" rx="2" className="summary-track" />
      {total > 0 && amounts[index] > 0 && <rect x={barX} y={193 + index * 36} width={Math.floor((barEnd - barX) * amounts[index] / total + .5)} height="4" rx="2" className="summary-share" />}
      <text className="summary-row-value" x={w - p} y={202 + index * 36} textAnchor="end">{short(row.value, 112, 18)}</text>
    </g>)}
  </svg>;
}
