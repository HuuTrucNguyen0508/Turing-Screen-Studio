import type { GraphWidget } from './domain/layout';
import { GRAPH_AREA_MIX, demoGraphHistory, graphArea, graphChart } from './domain/graph';
import { trendCaption } from './domain/trend';
import './sensor-card-styles.css';

const points = (list: readonly { x: number; y: number }[]) => list.map(({ x, y }) => `${x},${y}`).join(' ');

export default function GraphContent({ widget }: { widget: GraphWidget }) {
  const { width, height, settings } = widget;
  const chart = graphChart(settings.label, settings.sources, settings.sources.map((source) => demoGraphHistory(source)), width, height);
  const { left, right } = chart;
  return <div className="sensor-card" data-sensor-card="graph" data-graph-style={settings.style}>
    <svg width={width} height={height} role="img" aria-label={`${settings.label || 'History'}: ${chart.series.map((series) => `${series.name} ${series.reading.value} ${series.reading.unit}`).join(', ')}, ${chart.range}, ${trendCaption(true)}`}>
      {chart.kicker && <text className="sensor-kicker" x={left} y={42}>{chart.kicker}</text>}
      {chart.series.map(({ source, role, name, primary, reading, legend }) => <g key={source} data-graph-series={source}>
        {legend.nameY !== null && <>
          {primary ? <rect x={legend.x} y={legend.nameY - 10} width={10} height={10} fill={`var(--${role})`} />
            : <rect x={legend.x + 1} y={legend.nameY - 9} width={8} height={8} fill="none" stroke={`var(--${role})`} strokeWidth={2} />}
          <text className="sensor-note" x={legend.x + 16} y={legend.nameY} fontSize={13}>{name}</text>
        </>}
        <text className="sensor-mono" x={legend.x} y={legend.valueY} fill={`var(--${role})`} fontSize={legend.valueSize}>{reading.value}
          {reading.unit && <tspan className="sensor-unit" dx={6} fontSize={legend.unitSize}>{reading.unit}</tspan>}</text>
      </g>)}
      {chart.showChart && <>
        <text className="sensor-note" x={right} y={chart.rangeY} textAnchor="end" fontSize={11}>{chart.range}</text>
        {[chart.top, chart.middle, chart.bottom].map((y) => <line key={y} className="sensor-rule" x1={left} x2={right} y1={y + .5} y2={y + .5} />)}
        {settings.style === 'area' && chart.series[0].segments.filter((segment) => segment.length > 1).map((segment, index) =>
          <polygon key={index} points={points(graphArea(segment, chart.bottom))} style={{ fill: `color-mix(in srgb, var(--${chart.series[0].role}) ${GRAPH_AREA_MIX * 100}%, var(--surface))` }} />)}
        {chart.series.map(({ source, role, primary, lines, segments }) => <g key={source} stroke={`var(--${role})`} fill={`var(--${role})`}>
          {lines.map((line, index) => <polyline key={index} points={points(line)} fill="none" strokeWidth={primary ? 2 : 1} strokeLinejoin="round" />)}
          {segments.filter((segment) => segment.length === 1).map(([point], index) => <circle key={`dot-${index}`} cx={point.x} cy={point.y} r={1} stroke="none" />)}
        </g>)}
        {chart.series.map(({ source, role, primary, last }) => last && <g key={source} data-graph-now={source}>
          <circle cx={last.x} cy={last.y} r={6} fill="var(--surface)" />
          {primary ? <circle cx={last.x} cy={last.y} r={4} fill={`var(--${role})`} />
            : <circle cx={last.x} cy={last.y} r={3} fill="var(--surface)" stroke={`var(--${role})`} strokeWidth={2} />}
        </g>)}
        {chart.state && <text className="sensor-note" x={left} y={chart.middle - 8} fontSize={13}>{chart.state}</text>}
      </>}
      <text className="sensor-note" x={left} y={chart.captionY} fontSize={12}>{trendCaption(true)}</text>
    </svg>
  </div>;
}
