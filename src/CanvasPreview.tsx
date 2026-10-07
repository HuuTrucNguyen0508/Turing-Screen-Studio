import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode, SetStateAction } from 'react';
import { fitCanvas, pointerDeltaToDocument, updateGeometry } from './domain/layout';
import type { LayoutDocument, Widget } from './domain/layout';
import { canvasWarnings, moveSelection, snapResize, snapSelection } from './domain/canvas';
import type { CanvasGuide } from './domain/canvas';
import CanvasTools from './CanvasTools';
import DesignMarker from './DesignMarker';
import { CardContent, widgetLabel } from './WidgetContent';
import { dashboardHeading } from './domain/usage';
export { widgetLabel } from './WidgetContent';

type Props = {
  document: LayoutDocument;
  selectedId: string | null;
  selectedIds: readonly string[];
  onSelect: (id: string, toggle?: boolean, preserve?: boolean) => void;
  onChange: (update: SetStateAction<LayoutDocument>) => void;
  getDocument: () => LayoutDocument;
  getSelection: () => readonly string[];
  onGestureStart: () => void;
  onGestureEnd: (cancel: boolean) => void;
  previewControls?: ReactNode;
  previewNotice?: string;
  onPreviewRetry?: () => void;
  designElement?: string | null;
  bitmap?: string | null;
};

type Gesture = {
  pointerId: number;
  target: HTMLElement;
  startX: number;
  startY: number;
  scale: number;
  viewportWidth: number;
  viewportHeight: number;
  document: LayoutDocument;
  ids: readonly string[];
  widget?: Widget;
  pan: { x: number; y: number };
  mode: 'move' | 'resize' | 'pan';
};

const SNAP_PREFERENCE = 'turzx-studio:snapping:v1';
function initialSnapping() {
  try { return localStorage.getItem(SNAP_PREFERENCE) !== 'off'; }
  catch { return true; }
}

export default function CanvasPreview({ document, selectedId, selectedIds, onSelect, onChange, getDocument, getSelection, onGestureStart, onGestureEnd, bitmap, previewControls, previewNotice, onPreviewRetry, designElement }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const endRef = useRef(onGestureEnd);
  endRef.current = onGestureEnd;
  const finishRef = useRef<(cancel?: boolean) => void>(() => {});
  const suppressFocus = useRef(false);
  const spaceRef = useRef(false);
  const [space, setSpace] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [gesturing, setGesturing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [snapping, setSnapping] = useState(initialSnapping);
  const [guides, setGuides] = useState<readonly CanvasGuide[]>([]);
  const fit = size.width > 0 && size.height > 0
    ? fitCanvas(document.canvas.width, document.canvas.height, size.width, size.height)
    : { scale: 0, offsetX: 0, offsetY: 0 };
  const scale = fit.scale * zoom;
  const offsetX = (size.width - document.canvas.width * scale) / 2 + pan.x;
  const offsetY = (size.height - document.canvas.height * scale) / 2 + pan.y;
  const warnings = canvasWarnings(document);

  function finish(cancel = false) {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    setGesturing(false); setGuides([]);
    if (gesture.mode === 'pan') { if (cancel) setPan(gesture.pan); }
    else endRef.current(cancel);
    if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
  }
  finishRef.current = finish;

  useLayoutEffect(() => {
    const viewport = viewportRef.current!;
    const bounds = viewport.getBoundingClientRect();
    setSize({ width: bounds.width, height: bounds.height });
    const observer = new ResizeObserver(([entry]) => {
      finishRef.current(true);
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(viewport);
    return () => { observer.disconnect(); finishRef.current(true); };
  }, []);

  useEffect(() => {
    const cancel = () => { finishRef.current(true); spaceRef.current = false; setSpace(false); };
    const down = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { if (gestureRef.current) { event.preventDefault(); event.stopPropagation(); } cancel(); }
      const target = event.target as HTMLElement;
      if (event.code === 'Space' && !event.isComposing && !target.closest('input, select, textarea, [contenteditable]')) {
        spaceRef.current = true; setSpace(true);
        if (viewportRef.current?.contains(target) && !target.closest('button')) event.preventDefault();
      }
    };
    const up = (event: globalThis.KeyboardEvent) => { if (event.code === 'Space') { spaceRef.current = false; setSpace(false); } };
    window.addEventListener('blur', cancel); window.addEventListener('resize', cancel); window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  function capture(event: PointerEvent<HTMLElement>, mode: Gesture['mode'], widget?: Widget) {
    event.preventDefault(); event.stopPropagation(); finish(true);
    event.currentTarget.focus({ preventScroll: true });
    // Focus commits pending inspector text before taking the original document snapshot.
    const original = getDocument();
    const ids = getSelection();
    const currentWidget = widget ? original.widgets.find((entry) => entry.id === widget.id) : undefined;
    if (mode !== 'pan') onGestureStart();
    event.currentTarget.setPointerCapture(event.pointerId);
    const viewport = viewportRef.current!.getBoundingClientRect();
    gestureRef.current = { viewportWidth: viewport.width, viewportHeight: viewport.height, pointerId: event.pointerId, target: event.currentTarget, startX: event.clientX, startY: event.clientY, scale,
      document: original, ids: [...ids], widget: currentWidget, mode, pan };
    setGesturing(true);
  }

  function begin(event: PointerEvent<HTMLElement>, widget: Widget, mode: 'move' | 'resize') {
    if (event.button !== 0 || !event.isPrimary || scale <= 0) return;
    event.preventDefault(); event.stopPropagation();
    if (event.shiftKey) {
      finish(true); onSelect(widget.id, true);
      suppressFocus.current = true; event.currentTarget.focus({ preventScroll: true }); suppressFocus.current = false;
      return;
    }
    onSelect(widget.id, false, true);
    if (mode === 'resize' && getSelection().length !== 1) return;
    capture(event, mode, widget);
  }

  function move(event: PointerEvent) {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const viewport = viewportRef.current!.getBoundingClientRect();
    if (viewport.width !== gesture.viewportWidth || viewport.height !== gesture.viewportHeight) { finish(true); return; }
    if (gesture.mode === 'pan') { setPan({ x: gesture.pan.x + event.clientX - gesture.startX, y: gesture.pan.y + event.clientY - gesture.startY }); return; }
    const delta = pointerDeltaToDocument(event.clientX - gesture.startX, event.clientY - gesture.startY, gesture.scale);
    if (gesture.mode === 'move') {
      if (delta.x === 0 && delta.y === 0) {
        setGuides([]); onChange(gesture.document); return;
      }
      const snap = snapping ? snapSelection(gesture.document, gesture.ids, delta.x, delta.y) : { dx: delta.x, dy: delta.y, guides: [] };
      setGuides(snap.guides);
      onChange(moveSelection(gesture.document, gesture.ids, snap.dx, snap.dy));
    } else {
      const widget = gesture.widget!;
      const width = Math.max(1, Math.min(gesture.document.canvas.width - widget.x, widget.width + delta.x));
      const height = Math.max(1, Math.min(gesture.document.canvas.height - widget.y, widget.height + delta.y));
      const next = snapping ? snapResize(gesture.document, widget.id, width, height) : { width, height, guides: [] };
      setGuides(next.guides);
      onChange(updateGeometry(gesture.document, widget.id, { width: next.width, height: next.height }));
    }
  }

  function view(nextZoom: number, fitView = false) { finish(true); setZoom(Math.max(.25, Math.min(4, nextZoom))); if (fitView) setPan({ x: 0, y: 0 }); }
  const selected = document.widgets.find((widget) => widget.id === selectedId);
  return <section className="preview-panel" aria-label="Layout preview">
    <div className="panel-heading"><div><span className="eyebrow">Landscape panel</span><h2>Canvas</h2></div><span className="mono">{document.canvas.width} × {document.canvas.height} px</span></div>
    {previewControls}
    <CanvasTools document={document} selectedIds={selectedIds} selectedId={selectedId} busy={gesturing} onChange={onChange} />
    <div className="canvas-view-tools" aria-label="Canvas view">
      <label><input type="checkbox" aria-label="Snapping" checked={snapping} onChange={(event) => {
        finish(true); setSnapping(event.target.checked);
        try { localStorage.setItem(SNAP_PREFERENCE, event.target.checked ? 'on' : 'off'); } catch { /* The current tab still keeps the choice. */ }
      }} />Snapping <span>Move & resize · 24 px gutters</span></label>
      <div><button aria-label="Zoom out" disabled={zoom <= .25} onClick={() => view(zoom / 1.25)}>−</button><span aria-label="Canvas zoom">{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" disabled={zoom >= 4} onClick={() => view(zoom * 1.25)}>+</button><button onClick={() => view(1, true)}>Fit</button></div>
    </div>
    <div className="preview-instructions"><span>{previewNotice || 'Shift-click to select cards together.'}{onPreviewRetry && <button className="text-button" onClick={onPreviewRetry}>Retry preview</button>}</span><span className="mono">Scale {Math.round(scale * 100)}%</span></div>
    <div className={`canvas-viewport${gesturing ? ' gesturing' : ''}${space ? ' pan-ready' : ''}`} ref={viewportRef} tabIndex={0} aria-label="Canvas viewport"
      onPointerDownCapture={(event) => { if ((event.button === 1 || (event.button === 0 && spaceRef.current)) && event.isPrimary && scale > 0) capture(event, 'pan'); }}
      onPointerMove={move} onPointerUp={(event) => { if (event.pointerId === gestureRef.current?.pointerId) { move(event); finish(); } }}
      onPointerCancel={(event) => { if (event.pointerId === gestureRef.current?.pointerId) finish(true); }}
      onLostPointerCapture={(event) => { if (event.pointerId === gestureRef.current?.pointerId && event.target === gestureRef.current.target) finish(true); }}
      onKeyDown={(event) => { if (gestureRef.current && event.key !== 'Escape' && event.code !== 'Space') { event.preventDefault(); event.stopPropagation(); } }}>
      <div className={`document-canvas${bitmap ? ' rendered-canvas' : ''}`} data-testid="document-canvas" style={{ width: document.canvas.width, height: document.canvas.height, left: offsetX, top: offsetY, transform: `scale(${scale})` }}>
        {bitmap ? <img className="rendered-frame" src={bitmap} alt={previewNotice?.includes('Live') || previewNotice?.includes('live') ? 'Panel renderer with live readings' : 'Panel renderer with sample data'} draggable={false} /> : <div className="dashboard-header" aria-hidden="true"><div><span className="card-kicker">TURZX / desktop</span><strong>{dashboardHeading(document)}</strong></div>{!document.widgets.some((widget) => widget.type === 'clock') && <div className="dashboard-time">10:24<span>Sunday, 4 October</span></div>}</div>}
        {document.widgets.map((widget) => <div key={widget.id} tabIndex={0} role="group" aria-label={`${widgetLabel(widget)} card`} aria-roledescription="movable card"
          data-widget-id={widget.id} data-selected={selectedIds.includes(widget.id)} data-primary={selectedId === widget.id}
          className={`dashboard-card ${selectedIds.includes(widget.id) ? 'selected' : ''}`}
          onFocus={() => { if (!suppressFocus.current) onSelect(widget.id, false, true); }} onPointerDown={(event) => begin(event, widget, 'move')}
          style={{ left: widget.x, top: widget.y, width: widget.width, height: widget.height, '--selection-width': `${2 / (scale || 1)}px` } as CSSProperties}>
          {!bitmap && <CardContent widget={widget} />}
          {selectedId === widget.id && designElement && <DesignMarker widget={widget} element={designElement} />}
          {selectedId === widget.id && selectedIds.length === 1 && <>
            <span className="selection-label" aria-hidden="true">{widget.width} × {widget.height}</span>
            <button className="resize-handle" type="button" aria-label={`Resize ${widgetLabel(widget)}`} title="Drag to resize, or use arrow keys when focused"
              style={{ width: 14 / (scale || 1), height: 14 / (scale || 1) }} onPointerDown={(event) => begin(event, widget, 'resize')}
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                const step = event.shiftKey ? 10 : 1;
                const directions: Record<string, { width?: number; height?: number }> = { ArrowRight: { width: widget.width + step }, ArrowLeft: { width: widget.width - step }, ArrowDown: { height: widget.height + step }, ArrowUp: { height: widget.height - step } };
                if (directions[event.key]) { event.preventDefault(); event.stopPropagation(); onChange((current) => updateGeometry(current, widget.id, directions[event.key])); }
              }} />
          </>}
        </div>)}
        {guides.map((guide) => <div key={`${guide.axis}:${guide.position}`} className={`snap-guide ${guide.axis}`} data-testid="snap-guide" aria-hidden="true" style={{ [guide.axis === 'x' ? 'left' : 'top']: guide.position, '--guide-width': `${1 / (scale || 1)}px` } as CSSProperties} />)}
        <div className="dashboard-footer" aria-hidden="true"><span>{bitmap && previewNotice?.includes('Live readings') ? 'Live readings' : 'Deterministic preview'}</span><span>{document.canvas.width} / {document.canvas.height}</span></div>
      </div>
    </div>
    <div className="preview-footer"><span className="mono">{selected ? `X ${selected.x} / Y ${selected.y}` : 'Select a card to edit'}</span><span>Arrows 1 px · Shift 10 px · Space-drag to pan</span></div>
    <details className="canvas-warnings"><summary>{warnings.length === 100 ? '100+' : warnings.length} layout notes</summary><div className="canvas-warning-content"><p>Informational. You can still export and save this layout.</p><ul>{warnings.slice(0, 8).map((warning, index) => <li key={index}>{warning.message}</li>)}</ul>{warnings.length > 8 && <p>{warnings.length - 8} more notes. Review overlapping or small cards.</p>}</div></details>
  </section>;
}
