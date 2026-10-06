import { formatClockTime, formatGaugeNumber, gaugeFraction, gaugeGeometry, instrumentGeometry } from './domain/widgets';
import type { GaugeWidget, LayoutDocument, Widget } from './domain/layout';
import './widget-styles.css';
import StorageContent from './StorageContent';
import UsageContent from './UsageContent';
import { dashboardHeading, isUsageSource } from './domain/usage';

export function widgetLabel(widget: Widget): string {
  if (widget.type === 'weather') return widget.settings.location || 'Weather';
  if (widget.type === 'text') return widget.settings.label || widget.settings.text.slice(0, 24) || 'Text';
  return widget.settings.label || (widget.type === 'clock' ? 'Clock' : widget.type === 'gauge' ? 'Gauge' : widget.type === 'storage' ? 'Mounted storage' : 'Metric');
}

function arc(cx: number, cy: number, radius: number, fraction: number): string {
  const point = (degrees: number) => [cx + radius * Math.cos(degrees * Math.PI / 180), cy + radius * Math.sin(degrees * Math.PI / 180)];
  const [x, y] = point(150), [endX, endY] = point(150 + 240 * fraction);
  return `M${x} ${y} A${radius} ${radius} 0 ${fraction > .75 ? 1 : 0} 1 ${endX} ${endY}`;
}

function Instrument({ widget }: { widget: GaugeWidget }) {
  const { style, label, value, min, max, unit, detail } = widget.settings;
  const { padding: p, available, radius: r, cx, cy, meterY, size, showShape } = instrumentGeometry(widget.width, widget.height);
  const fraction = value == null ? 0 : gaugeFraction(value, min, max);
  let valueX = cx, valueY = Math.floor(widget.height * .55), valueSize = size, align: 'middle' | 'start' = 'middle';
  if (style === 'ring' && showShape && r >= 24) valueY = cy + Math.floor(size * .36);
  if (style === 'bar' || style === 'segments') { valueY = meterY - 16; valueX = p; valueSize = Math.max(12, Math.min(size, meterY - 64)); align = 'start'; }
  if (style === 'number') valueSize = Math.max(12, Math.min(80, Math.floor(available / 3), valueY - 52));
  const stemX = p + 20, stemTop = 66, bulbY = widget.height - 82, bulbR = 14;
  if (style === 'thermometer' && showShape) { valueX = (stemX + 28 + widget.width - p) / 2; valueSize = Math.max(12, Math.min(size, Math.floor((widget.width - p - stemX - 28) / 4))); }
  const bound = (x: number, y: number, number: number, anchor: 'start' | 'end' = 'start') => <text x={x} y={y} textAnchor={anchor} className="instrument-bound">{formatGaugeNumber(number)}</text>;
  return <div className="gauge-content instrument-content" data-gauge-style={style}>
    {label && <span className="card-kicker">{label}</span>}
    <svg width={widget.width} height={widget.height} aria-hidden="true">
      {showShape && style === 'ring' && r >= 24 && <>
        <circle className="instrument-track" cx={cx} cy={cy} r={r} fill="none" strokeWidth="10" />
        {fraction > 0 && <circle className="instrument-progress" cx={cx} cy={cy} r={r} fill="none" strokeWidth="10" pathLength="1" strokeDasharray={`${fraction} 1`} transform={`rotate(-90 ${cx} ${cy})`} />}
        {bound(p, widget.height - 64, min)}{bound(widget.width - p, widget.height - 64, max, 'end')}
      </>}
      {showShape && style === 'bar' && <>
        <rect className="instrument-track" x={p} y={meterY} width={available} height="16" />
        {fraction > 0 && <rect className="instrument-progress" x={p} y={meterY} width={available * fraction} height="16" />}
        {bound(p, meterY + 38, min)}{bound(widget.width - p, meterY + 38, max, 'end')}
      </>}
      {showShape && style === 'segments' && <>
        {Array.from({ length: 16 }, (_, index) => <rect key={index} data-segment={index} className={index < Math.floor(fraction * 16) ? 'instrument-progress' : 'instrument-track'} x={p + index * available / 16} y={meterY - 6} width={Math.max(1, available / 16 - 4)} height="28" />)}
        {bound(p, meterY + 44, min)}{bound(widget.width - p, meterY + 44, max, 'end')}
      </>}
      {showShape && style === 'thermometer' && <>
        <rect className="instrument-track" x={stemX - 6} y={stemTop} width="12" height={bulbY - stemTop} />
        <circle className="instrument-track" cx={stemX} cy={bulbY} r={bulbR} />
        {fraction > 0 && <><rect className="instrument-progress" x={stemX - 3} y={bulbY - (bulbY - stemTop) * fraction} width="6" height={(bulbY - stemTop) * fraction} /><circle className="instrument-progress" cx={stemX} cy={bulbY} r={bulbR - 4} /></>}
        {bound(stemX + 18, stemTop + 12, max)}{bound(stemX + 18, bulbY + 5, min)}
      </>}
      {showShape && style === 'number' && <>{bound(p, widget.height - 64, min)}{bound(widget.width - p, widget.height - 64, max, 'end')}</>}
      <text className="instrument-value" x={valueX} y={valueY} fontSize={valueSize} textAnchor={align}>{value == null ? '—' : formatGaugeNumber(value)}<tspan className="instrument-unit" dx="6" fontSize={Math.floor(valueSize * .4)}>{unit}</tspan></text>
      <text className="instrument-detail" x={cx} y={widget.height - 29}>{detail}</text>
    </svg>
  </div>;
}

export function CardContent({ widget }: { widget: Widget }) {
  if (widget.type === 'storage') return <StorageContent widget={widget} />;
  if (widget.type === 'clock') {
    const compact = widget.height < 184;
    const time = formatClockTime(widget.settings.time, widget.settings.format);
    const [digits, suffix] = time.split(' ');
    const baseline = compact ? Math.floor(widget.height / 2) + (widget.settings.showDate ? 4 : 15) : 124;
    return <div className={`clock-content${compact ? ' compact-clock' : ''}`}>
      {!compact && widget.settings.label && <span className="card-kicker">{widget.settings.label}</span>}
      <div className="clock-value" style={{ top: baseline - (compact ? 40 : 72) }}>{digits}{suffix && <span>{suffix}</span>}</div>
      {widget.settings.showDate && <div className="clock-date" style={{ top: compact ? Math.floor(widget.height / 2) + 12 : widget.height - 44 }}>{widget.settings.date}</div>}
    </div>;
  }
  if (widget.type === 'text') return <div className="text-content">
    {widget.settings.label && <span className="card-kicker">{widget.settings.label}</span>}
    <p style={{ top: widget.settings.label ? 58 : 27, height: Math.max(0, Math.floor((widget.height - 20 - (widget.settings.label ? 58 : 27)) / 28) * 28) }}>{widget.settings.text}</p>
  </div>;
  if (widget.type === 'gauge') {
    if (widget.settings.style && widget.settings.style !== 'arc') return <Instrument widget={widget} />;
    const { value, min, max, unit, detail, label } = widget.settings;
    const { radius, cx, cy, size } = gaugeGeometry(widget.width, widget.height);
    const fraction = gaugeFraction(value, min, max);
    return <div className="gauge-content" data-gauge-style="arc">
      {label && <span className="card-kicker">{label}</span>}
      {radius >= 24 && <svg width={widget.width} height={widget.height} aria-hidden="true">
        <path d={arc(cx, cy, radius, 1)} fill="none" stroke="var(--outline)" strokeWidth="10" />
        {fraction > 0 && <path d={arc(cx, cy, radius, fraction)} fill="none" stroke="var(--primary)" strokeWidth="10" />}
        <text x={cx - Math.round(.866 * radius)} y={cy + Math.floor(radius / 2) + 26} className="gauge-bound">{formatGaugeNumber(min)}</text>
        <text x={cx + Math.round(.866 * radius)} y={cy + Math.floor(radius / 2) + 26} className="gauge-bound">{formatGaugeNumber(max)}</text>
      </svg>}
      <div className="gauge-value" style={{ fontSize: size, top: radius >= 24 ? cy + Math.floor(size * .36) - size : 62 }}>{formatGaugeNumber(value)}<span style={{ fontSize: Math.floor(size * .4) }}>{unit}</span></div>
      <span className="gauge-detail">{detail}</span>
    </div>;
  }
  if (widget.type === 'weather') return <div className="weather-content">
    <span className="card-kicker">Weather / {widget.settings.location}</span>
    <svg className="weather-icon" viewBox="0 0 120 100" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <circle cx="76" cy="32" r="17" />
        <path d="M76 5V0M76 64v-5M103 32h8M42 32h7M96 12l6-6M50 58l6-6M96 52l6 6M50 6l6 6" />
        <path d="M29 83a17 17 0 0 1-1-34 24 24 0 0 1 46 2 16 16 0 1 1 4 32H29Z" fill="var(--surface)" />
      </g>
    </svg>
    <div className="weather-temperature">{widget.settings.temperature}<span>{widget.settings.unit}</span></div>
    <p>{widget.settings.condition}</p>
    <div className="weather-range"><span>High {widget.settings.high}°</span><span>Low {widget.settings.low}°</span></div>
    <div className="weather-caption">Sample forecast</div>
  </div>;
  if (isUsageSource(widget.settings.source)) return <UsageContent widget={widget} />;
  return <div className="metric-content">
    <span className="card-kicker">{widget.settings.label}</span>
    <div className="metric-value">{widget.settings.value}<span>{widget.settings.unit}</span></div>
    <svg className="sparkline" viewBox="0 0 300 32" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 26H300" stroke="var(--outline)" strokeWidth="1" />
      <path d="M0 22L20 23L40 17L60 21L80 13L100 16L120 8L140 14L160 12L180 19L200 11L220 16L240 9L260 13L280 5L300 10" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
    <span className="metric-detail">{widget.settings.detail}</span>
  </div>;
}

export function StaticLayout({ document }: { document: LayoutDocument }) {
  return <div className="preset-thumbnail" aria-hidden="true"><div className="static-document" style={{ width: document.canvas.width, height: document.canvas.height, transform: `scale(${240 / document.canvas.width})` }}>
    <div className="dashboard-header"><div><span className="card-kicker">TURZX / desktop</span><strong>{dashboardHeading(document)}</strong></div>{!document.widgets.some((widget) => widget.type === 'clock') && <div className="dashboard-time">10:24<span>Sunday, 4 October</span></div>}</div>
    {document.widgets.map((widget) => <div key={widget.id} className="dashboard-card" style={{ left: widget.x, top: widget.y, width: widget.width, height: widget.height }}><CardContent widget={widget} /></div>)}
    <div className="dashboard-footer"><span>Deterministic preview</span><span>{document.canvas.width} / {document.canvas.height}</span></div>
  </div></div>;
}
