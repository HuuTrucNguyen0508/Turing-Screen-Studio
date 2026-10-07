import type { MetricWidget } from './domain/layout';
import './usage-styles.css';
import UsageSummaryContent from './UsageSummaryContent';
import { isUsageSummary } from './domain/usage';

export default function UsageContent({ widget }: { widget: MetricWidget }) {
  if (isUsageSummary(widget.settings.source)) return <UsageSummaryContent widget={widget} />;
  const { label, value, unit, detail, source } = widget.settings;
  const modelLines = detail.split('\n');
  const rows = modelLines.slice(1).filter(line => line.split('\t').length === 3);
  if (source?.endsWith('-models') && rows.length) {
    const nameChars = Math.max(1, Math.floor((widget.width - 158) / 6.6));
    const capacity = Math.max(0, Math.floor((widget.height - 78) / 18));
    const shown = rows.slice(0, capacity);
    const note = (shown.length < rows.length ? `+${rows.length - shown.length} more · ` : '') + modelLines[0];
    return <svg className="usage-content" width={widget.width} height={widget.height} aria-hidden="true">
      <text className="usage-label" x="29" y="25">{label}</text>
      <text className="usage-model-number" x={widget.width - 29} y="25" textAnchor="end">{value}</text>
      <text className="usage-model-heading" x="29" y="43">Model</text>
      <text className="usage-model-heading" x={widget.width - 80} y="43" textAnchor="end">Tokens</text>
      <text className="usage-model-heading" x={widget.width - 29} y="43" textAnchor="end">USD*</text>
      {shown.map((line, index) => {
        const [name, tokens, cost] = line.split('\t');
        return <g className="usage-model-row" key={index}>
          <text className="usage-model-name" x="29" y={60 + index * 18}>{name.length > nameChars ? name.slice(0, Math.max(0, nameChars - 1)) + '…' : name}</text>
          <text className="usage-model-number" x={widget.width - 80} y={60 + index * 18} textAnchor="end">{tokens}</text>
          <text className="usage-model-number" x={widget.width - 29} y={60 + index * 18} textAnchor="end">{cost}</text>
        </g>;
      })}
      <text className="usage-model-heading" x="29" y={widget.height - 23}>{note.slice(0, Math.floor((widget.width - 58) / 6.1))}</text>
    </svg>;
  }
  const compact = widget.height < 184;
  const size = Math.max(12, Math.min(compact ? 36 : 52, Math.floor(Math.max(1, widget.width - 58) / Math.max(1, value.length * .64))));
  const baseline = compact ? 76 : 58 + size;
  const chars = Math.max(1, Math.floor((widget.width - 58) / 7.7));
  const lines = detail.match(new RegExp(`.{1,${chars}}(?:\\s|$)|.{1,${chars}}`, 'g'))?.slice(0, compact ? 1 : 2) ?? [];
  return <svg className="usage-content" width={widget.width} height={widget.height} aria-hidden="true">
    <text className="usage-label" x="29" y={compact ? 25 : 42}>{label}</text>
    <text className="usage-value" x="29" y={baseline} fontSize={size}>{value}</text>
    {unit && <text className="usage-unit" x={compact ? 38 + value.length * size * .64 : 29} y={compact ? baseline : baseline + 27}>{unit}</text>}
    {lines.map((line, index) => <text key={index} className="usage-detail" x="29" y={widget.height - (lines.length - index - 1) * 19 - 23}>{line.trim()}</text>)}
  </svg>;
}
