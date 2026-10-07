import type { Widget } from './domain/layout';
import { elementSpecs, resolveElements } from './domain/design';
import './design-styles.css';

const DEFAULT_PADDING = 29;
const ARM = 9;
const TICK = 18;

function coordinate(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Editor-only overlay in widget-local document coordinates: side padding guides plus a crosshair at the
 * inspected element's anchor and baseline. Root renders it inside the selected card, never in exports.
 */
export default function DesignMarker({ widget, element }: { widget: Widget; element: string | null }) {
  if (!elementSpecs(widget).length) return null;
  const padding = widget.design?.padding ?? DEFAULT_PADDING;
  const target = element === null ? undefined : resolveElements(widget).find((item) => item.id === element);
  const { width, height } = widget;
  return <svg className="design-marker" aria-hidden="true" focusable="false"
    width={width} height={height} viewBox={`0 0 ${width} ${height}`} overflow="visible">
    <line className="design-marker-padding" x1={padding} y1={0} x2={padding} y2={height} />
    <line className="design-marker-padding" x1={width - padding} y1={0} x2={width - padding} y2={height} />
    {target && <g className={`design-marker-anchor${target.hidden ? ' hidden' : ''}`}>
      <line x1={target.x - ARM} y1={target.y} x2={target.x + ARM} y2={target.y} />
      <line x1={target.x} y1={target.y - ARM} x2={target.x} y2={target.y + ARM} />
      <line className="design-marker-tick"
        x1={target.align === 'start' ? target.x : target.x - TICK}
        x2={target.align === 'end' ? target.x : target.x + TICK}
        y1={target.y} y2={target.y} />
      <circle cx={target.x} cy={target.y} r={2.5} />
    </g>}
    {target && <text className="design-marker-caption" x={10} y={height + 24}>
      {`${target.id} · ${coordinate(target.x)}, ${coordinate(target.y)}${target.hidden ? ' · hidden' : ''}`}
    </text>}
  </svg>;
}
