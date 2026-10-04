import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, SetStateAction } from 'react';
import { fitCanvas, pointerDeltaToDocument, updateGeometry } from './domain/layout';
import type { LayoutDocument, Widget } from './domain/layout';

type Props = {
  document: LayoutDocument;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (update: SetStateAction<LayoutDocument>) => void;
  getDocument: () => LayoutDocument;
  bitmap?: string | null;
};

type Gesture = {
  pointerId: number;
  target: HTMLElement;
  startX: number;
  startY: number;
  scale: number;
  widget: Widget;
  mode: 'move' | 'resize';
};

export function widgetLabel(widget: Widget) {
  return widget.type === 'metric' ? widget.settings.label : widget.settings.location;
}

function CardContent({ widget }: { widget: Widget }) {
  if (widget.type === 'weather') {
    return <div className="weather-content">
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
  }
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

export default function CanvasPreview({ document, selectedId, onSelect, onChange, getDocument, bitmap }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [gesturing, setGesturing] = useState(false);
  const fit = size.width > 0 && size.height > 0
    ? fitCanvas(document.canvas.width, document.canvas.height, size.width, size.height)
    : { scale: 0, offsetX: 0, offsetY: 0 };

  function restore(gesture: Gesture) {
    const { x, y, width, height } = gesture.widget;
    onChangeRef.current((current) => updateGeometry(current, gesture.widget.id, { x, y, width, height }));
  }

  function finish(cancel = false) {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    setGesturing(false);
    if (cancel) restore(gesture);
    if (gesture.target.hasPointerCapture(gesture.pointerId)) {
      gesture.target.releasePointerCapture(gesture.pointerId);
    }
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current!;
    const bounds = viewport.getBoundingClientRect();
    setSize({ width: bounds.width, height: bounds.height });
    const observer = new ResizeObserver(([entry]) => {
      // A gesture's coordinate mapping stays fixed. Resizing cancels it.
      const gesture = gestureRef.current;
      if (gesture) {
        gestureRef.current = null;
        const { x, y, width, height } = gesture.widget;
        onChangeRef.current((current) => updateGeometry(current, gesture.widget.id, { x, y, width, height }));
        setGesturing(false);
        if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
      }
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const cancel = () => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gestureRef.current = null;
      setGesturing(false);
      const { x, y, width, height } = gesture.widget;
      onChangeRef.current((current) => updateGeometry(current, gesture.widget.id, { x, y, width, height }));
      if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
    };
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, []);

  function begin(event: PointerEvent<HTMLElement>, widget: Widget, mode: Gesture['mode']) {
    if (event.button !== 0 || !event.isPrimary || fit.scale <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    finish();
    onSelect(widget.id);
    event.currentTarget.focus({ preventScroll: true });
    // Focusing commits an inspector draft on blur. Start from that committed geometry.
    const currentWidget = getDocument().widgets.find((entry) => entry.id === widget.id)!;
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId, target: event.currentTarget,
      startX: event.clientX, startY: event.clientY, scale: fit.scale,
      widget: currentWidget, mode,
    };
    setGesturing(true);
  }

  function move(event: PointerEvent) {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const delta = pointerDeltaToDocument(event.clientX - gesture.startX, event.clientY - gesture.startY, gesture.scale);
    const patch = gesture.mode === 'move'
      ? { x: gesture.widget.x + delta.x, y: gesture.widget.y + delta.y }
      : { width: gesture.widget.width + delta.x, height: gesture.widget.height + delta.y };
    onChange((current) => updateGeometry(current, gesture.widget.id, patch));
  }

  const selected = document.widgets.find((widget) => widget.id === selectedId);
  return <section className="preview-panel" aria-label="Layout preview">
    <div className="panel-heading"><div><span className="eyebrow">Landscape panel</span><h2>Canvas</h2></div>
      <span className="mono">{document.canvas.width} × {document.canvas.height} px</span>
    </div>
    <div className="preview-instructions"><span>Drag a card to move it. Pull its corner to resize.</span><span className="mono">Fit {Math.round(fit.scale * 100)}%</span></div>
    <div className={`canvas-viewport${gesturing ? ' gesturing' : ''}`} ref={viewportRef}
      onPointerMove={move} onPointerUp={(event) => { if (event.pointerId === gestureRef.current?.pointerId) { move(event); finish(); } }}
      onPointerCancel={(event) => {
        if (event.pointerId === gestureRef.current?.pointerId && event.target === gestureRef.current.target) finish(true);
      }} onLostPointerCapture={(event) => {
        if (event.pointerId === gestureRef.current?.pointerId && event.target === gestureRef.current.target) finish(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && gestureRef.current) { event.stopPropagation(); finish(true); }
        else if (gestureRef.current) { event.preventDefault(); event.stopPropagation(); }
      }}>
      <div className={`document-canvas${bitmap ? ' rendered-canvas' : ''}`} data-testid="document-canvas" style={{
        width: document.canvas.width, height: document.canvas.height,
        left: fit.offsetX, top: fit.offsetY, transform: `scale(${fit.scale})`,
      }}>
        {bitmap ? <img className="rendered-frame" src={bitmap} alt="Panel renderer with sample data" draggable={false} /> : <div className="dashboard-header" aria-hidden="true"><div><span className="card-kicker">TURZX / desktop</span><strong>System overview</strong></div><div className="dashboard-time">10:24<span>Sunday, 4 October</span></div></div>}
        {document.widgets.map((widget) => <div key={widget.id} tabIndex={0} role="group"
          aria-label={`${widgetLabel(widget)} card`} aria-roledescription="movable card"
          data-widget-id={widget.id} data-selected={selectedId === widget.id}
          className={`dashboard-card ${selectedId === widget.id ? 'selected' : ''}`}
          onFocus={() => onSelect(widget.id)} onPointerDown={(event) => begin(event, widget, 'move')}
          style={{ left: widget.x, top: widget.y, width: widget.width, height: widget.height, '--selection-width': `${2 / (fit.scale || 1)}px` } as CSSProperties}>
          {!bitmap && <CardContent widget={widget} />}
          {selectedId === widget.id && <>
            <span className="selection-label" aria-hidden="true">{widget.width} × {widget.height}</span>
            <button className="resize-handle" type="button" aria-label={`Resize ${widgetLabel(widget)}`}
              title="Drag to resize, or use arrow keys when focused"
              style={{ width: 14 / (fit.scale || 1), height: 14 / (fit.scale || 1) }}
              onPointerDown={(event) => begin(event, widget, 'resize')}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 10 : 1;
                const directions: Record<string, { width?: number; height?: number }> = {
                  ArrowRight: { width: widget.width + step }, ArrowLeft: { width: widget.width - step },
                  ArrowDown: { height: widget.height + step }, ArrowUp: { height: widget.height - step },
                };
                if (directions[event.key]) { event.preventDefault(); event.stopPropagation(); onChange((current) => updateGeometry(current, widget.id, directions[event.key])); }
              }} />
          </>}
        </div>)}
        <div className="dashboard-footer" aria-hidden="true"><span>Deterministic preview</span><span>1280 / 800</span></div>
      </div>
    </div>
    <div className="preview-footer"><span className="mono">{selected ? `X ${selected.x} / Y ${selected.y}` : 'Select a card to edit'}</span><span>Arrow keys 1 px · Shift 10 px · Esc cancels a drag</span></div>
  </section>;
}
