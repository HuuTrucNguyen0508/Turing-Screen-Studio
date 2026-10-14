import type { ListWidget } from './domain/layout';
import { listBarRole, listLayout } from './domain/list';
import './sensor-card-styles.css';

export default function ListContent({ widget }: { widget: ListWidget }) {
  const { width, height, settings } = widget;
  const layout = listLayout(width, height, settings.label, settings.rows, settings.bars);
  const left = layout.padding, right = width - layout.padding;
  return <div className="sensor-card" data-sensor-card="list">
    <svg width={width} height={height} role="img" aria-label={`${settings.label || 'Sensors'}: ${settings.rows.map((row) => `${row.label} ${row.value} ${row.unit}`).join(', ')}`}>
      {layout.kicker && <text className="sensor-kicker" x={left} y={42}>{layout.kicker}</text>}
      {layout.rows.map((row, index) => <g key={settings.rows[index].source} data-list-row={settings.rows[index].source}>
        <text x={left} y={row.baseline} fill="var(--text)" fontSize={layout.labelSize}>{row.label}</text>
        <text x={right} y={row.baseline} textAnchor="end" className="sensor-mono" fill="var(--text)" fontSize={layout.valueSize}>{row.value}
          {row.unit && <tspan className="sensor-unit" dx={4} fontSize={layout.unitSize}>{row.unit}</tspan>}</text>
        {row.barY !== null && right > left && <>
          <rect className="sensor-track" x={left} y={row.barY} width={right - left} height={6} rx={3} />
          {Math.floor((right - left) * row.fraction! + .5) > 0 && <rect className="sensor-bar" x={left} y={row.barY} width={Math.floor((right - left) * row.fraction! + .5)} height={6} rx={3} fill={`var(--${listBarRole(settings.rows[index].source)})`} />}
        </>}
      </g>)}
    </svg>
  </div>;
}
