import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode, SetStateAction } from 'react';
import { fitCanvas, pointerDeltaToDocument } from './domain/layout';
import type { LayoutDocument, Palette, Widget } from './domain/layout';
import { canvasWarnings, moveSelection, resizeFromHandle, snapSelection } from './domain/canvas';
import type { CanvasGuide, ResizeHandle } from './domain/canvas';
import DesignMarker from './DesignMarker';
import { CardContent, widgetLabel } from './WidgetContent';
import { dashboardHeading } from './domain/usage';
import { nudgeWidgetElement, resolveElements } from './domain/design';
import ShortcutsHelp from './ShortcutsHelp';
import ElementTargets from './ElementTargets';
import SelectionToolbar from './SelectionToolbar';
import CompactResize from './CompactResize';
import './canvas-interactions.css';
import { paletteStyle, widgetColorStyle } from './paletteStyles';
export { widgetLabel } from './WidgetContent';

type Props = {
  document: LayoutDocument;
  palette: Palette;
  selectedId: string | null;
  selectedIds: readonly string[];
  onSelect: (id: string, toggle?: boolean, preserve?: boolean) => void;
  onChange: (update: SetStateAction<LayoutDocument>) => void;
  getDocument: () => LayoutDocument;
  getSelection: () => readonly string[];
  onGestureStart: () => void;
  onGestureEnd: (cancel: boolean) => void;
  onResizeCanvas?: () => void;
  previewControls?: ReactNode;
  /** Adding, importing and the clipboard, shown above the canvas. */
  stageControls?: ReactNode;
  panelShortcuts: boolean;
  previewNotice?: string;
  onPreviewRetry?: () => void;
  designElement?: string | null;
  activeElement?: string | null;
  onCardDrag: () => void;
  onSelectElement: (id: string, element: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onCopy: (cut: boolean) => void;
  onDetails: () => void;
  onImportWidgets: (files: File[]) => void;
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
  mode: 'move' | 'resize' | 'pan' | 'element';
  handle?: ResizeHandle;
  element?: string;
  toolbarDocked: boolean;
  previewStatus: Pick<Props, 'previewNotice' | 'onPreviewRetry'>;
};

const handles: { id: ResizeHandle; name: string; x: number; y: number; cursor: string }[] = [
  { id: 'nw', name: 'top left', x: 0, y: 0, cursor: 'nwse-resize' },
  { id: 'n', name: 'top', x: .5, y: 0, cursor: 'ns-resize' },
  { id: 'ne', name: 'top right', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'e', name: 'right', x: 1, y: .5, cursor: 'ew-resize' },
  { id: 'se', name: 'bottom right', x: 1, y: 1, cursor: 'nwse-resize' },
  { id: 's', name: 'bottom', x: .5, y: 1, cursor: 'ns-resize' },
  { id: 'sw', name: 'bottom left', x: 0, y: 1, cursor: 'nesw-resize' },
  { id: 'w', name: 'left', x: 0, y: .5, cursor: 'ew-resize' },
];

const SNAP_PREFERENCE = 'turzx-studio:snapping:v1';
function initialSnapping() {
  try { return localStorage.getItem(SNAP_PREFERENCE) !== 'off'; }
  catch { return true; }
}

export default function CanvasPreview({ document, palette, selectedId, selectedIds, onSelect, onChange, getDocument, getSelection, onGestureStart, onGestureEnd, bitmap, onResizeCanvas, previewControls, stageControls, panelShortcuts, previewNotice, onPreviewRetry, designElement, activeElement, onCardDrag, onSelectElement, onDuplicate, onDelete, onCopy, onDetails, onImportWidgets }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 320, height: 46 });
  const gestureRef = useRef<Gesture | null>(null);
  const endRef = useRef(onGestureEnd);
  endRef.current = onGestureEnd;
  const finishRef = useRef<(cancel?: boolean) => void>(() => {});
  const suppressFocus = useRef(false);
  const spaceRef = useRef(false);
  const [space, setSpace] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [gesturing, setGesturing] = useState(false);
  const [resizeOpen, setResizeOpen] = useState(false);
  const [focusedHandle, setFocusedHandle] = useState<ResizeHandle | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [snapping, setSnapping] = useState(initialSnapping);
  const [guides, setGuides] = useState<readonly CanvasGuide[]>([]);
  const [fileHover, setFileHover] = useState(false);
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
    const observer = new ResizeObserver(() => {
      // A queued entry can describe the layout before the current gesture began.
      const bounds = viewport.getBoundingClientRect();
      const gesture = gestureRef.current;
      if (gesture && (bounds.width !== gesture.viewportWidth || bounds.height !== gesture.viewportHeight)) finishRef.current(true);
      setSize({ width: bounds.width, height: bounds.height });
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

  function capture(event: PointerEvent<HTMLElement>, mode: Gesture['mode'], widget?: Widget, handle?: ResizeHandle, element?: string) {
    event.preventDefault(); event.stopPropagation(); finish(true);
    event.currentTarget.focus({ preventScroll: true });
    // Focus commits pending inspector text before taking the original document snapshot.
    const original = getDocument();
    const ids = getSelection();
    const currentWidget = widget ? original.widgets.find((entry) => entry.id === widget.id) : undefined;
    if (mode !== 'pan') onGestureStart();
    event.currentTarget.setPointerCapture(event.pointerId);
    const viewport = viewportRef.current!.getBoundingClientRect();
    // Panel/selection changes may have resized the viewport before its observer runs.
    const currentScale = fitCanvas(original.canvas.width, original.canvas.height, viewport.width, viewport.height).scale * zoom;
    setSize({ width: viewport.width, height: viewport.height });
    gestureRef.current = { viewportWidth: viewport.width, viewportHeight: viewport.height, pointerId: event.pointerId, target: event.currentTarget, startX: event.clientX, startY: event.clientY, scale: currentScale,
      document: original, ids: [...ids], widget: currentWidget, mode, pan, handle, element, toolbarDocked, previewStatus: { previewNotice, onPreviewRetry } };
    setGesturing(true);
  }

  function begin(event: PointerEvent<HTMLElement>, widget: Widget, mode: 'move' | 'resize', handle?: ResizeHandle) {
    if (event.button !== 0 || !event.isPrimary || scale <= 0) return;
    event.preventDefault(); event.stopPropagation();
    if (event.shiftKey) {
      finish(true); onSelect(widget.id, true);
      suppressFocus.current = true; event.currentTarget.focus({ preventScroll: true }); suppressFocus.current = false;
      return;
    }
    onSelect(widget.id, false, true);
    const element = (event.target as Element).closest('[data-element-target]')?.getAttribute('data-element-target');
    if (mode === 'move' && selectedId === widget.id && selectedIds.length === 1 && element === activeElement && element) {
      capture(event, 'element', widget, undefined, element); return;
    }
    onCardDrag();
    if (mode === 'resize' && getSelection().length !== 1) return;
    capture(event, mode, widget, handle);
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
    } else if (gesture.mode === 'element') {
      onChange(nudgeWidgetElement(gesture.document, gesture.widget!.id, gesture.element!, delta.x, delta.y));
    } else {
      const widget = gesture.widget!;
      const next = resizeFromHandle(gesture.document, widget.id, gesture.handle!, delta.x, delta.y, snapping);
      setGuides(next.guides);
      onChange({ ...gesture.document, widgets: gesture.document.widgets.map((entry) => entry.id === widget.id
        ? { ...entry, x: next.x, y: next.y, width: next.width, height: next.height } : entry) });
    }
  }

  function view(nextZoom: number, fitView = false) { finish(true); setZoom(Math.max(.25, Math.min(4, nextZoom))); if (fitView) setPan({ x: 0, y: 0 }); }
  const selected = document.widgets.find((widget) => widget.id === selectedId);
  const movingElement = selected && activeElement ? resolveElements(selected).find((element) => element.id === activeElement) : null;
  const hasSelection = Boolean(selected);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const measure = () => {
      const { width, height } = toolbar.getBoundingClientRect();
      setToolbarSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(toolbar);
    return () => observer.disconnect();
  }, [hasSelection]);
  function toolbarPosition(): { style: CSSProperties; docked: boolean } {
    if (!selected) return { style: {}, docked: false };
    // Decide docking against the full stage, independent of the toolbar's current
    // docked height. Otherwise docking can repeatedly change its own fit result.
    const stage = viewportRef.current?.parentElement?.getBoundingClientRect();
    const availableWidth = stage?.width ?? size.width, availableHeight = stage?.height ?? size.height;
    const placementScale = availableWidth > 0 && availableHeight > 0
      ? fitCanvas(document.canvas.width, document.canvas.height, availableWidth, availableHeight).scale * zoom : scale;
    const placementX = (availableWidth - document.canvas.width * placementScale) / 2 + pan.x;
    const placementY = (availableHeight - document.canvas.height * placementScale) / 2 + pan.y;
    const cards = document.widgets.filter((widget) => selectedIds.includes(widget.id));
    const left = placementX + Math.min(...cards.map((widget) => widget.x)) * placementScale;
    const top = placementY + Math.min(...cards.map((widget) => widget.y)) * placementScale;
    const right = placementX + Math.max(...cards.map((widget) => widget.x + widget.width)) * placementScale;
    const bottom = placementY + Math.max(...cards.map((widget) => widget.y + widget.height)) * placementScale;
    const { width, height } = toolbarSize;
    const candidates = [
      { x: left, y: top - height - 14 }, { x: left - width - 14, y: top },
      { x: right + 14, y: top }, { x: left, y: bottom + 14 },
      { x: 4, y: 4 }, { x: availableWidth - width - 4, y: 4 },
      { x: 4, y: availableHeight - height - 4 }, { x: availableWidth - width - 4, y: availableHeight - height - 4 },
    ];
    for (const candidate of candidates) {
      const x = Math.max(4, Math.min(candidate.x, availableWidth - width - 4));
      const y = Math.max(4, Math.min(candidate.y, availableHeight - height - 4));
      if (document.widgets.some((widget) => {
        const wx = placementX + widget.x * placementScale, wy = placementY + widget.y * placementScale;
        return x < wx + widget.width * placementScale + 2 && x + width > wx - 2 && y < wy + widget.height * placementScale + 2 && y + height > wy - 2;
      })) continue;
      return { style: { left: x, top: y }, docked: false };
    }
    return { style: {}, docked: true };
  }
  const toolbarPlacement = toolbarPosition();
  // Keep the viewport size stable throughout a drag, even if free space changes.
  const toolbarDocked = gestureRef.current?.toolbarDocked ?? toolbarPlacement.docked;
  const previewStatus = gestureRef.current?.previewStatus ?? { previewNotice, onPreviewRetry };
  useLayoutEffect(() => {
    // Selection and optional tools can change the available height in this commit.
    // Update the letterbox before paint so cards do not jump on the next pointer event.
    const bounds = viewportRef.current!.getBoundingClientRect();
    if (bounds.width !== size.width || bounds.height !== size.height) setSize({ width: bounds.width, height: bounds.height });
  });
  const hitSize = size.width <= 560 ? 44 : 24;
  function handleInset(widget: Widget, handle: typeof handles[number]) {
    return {
      x: handle.x === 0 && widget.x === 0 ? hitSize / 2 + 1 : handle.x === 1 && widget.x + widget.width === document.canvas.width ? -hitSize / 2 - 1 : 0,
      y: handle.y === 0 && widget.y === 0 ? hitSize / 2 + 1 : handle.y === 1 && widget.y + widget.height === document.canvas.height ? -hitSize / 2 - 1 : 0,
    };
  }
  const handleCenters = selected ? handles.map((handle) => {
    const inset = handleInset(selected, handle);
    return { x: handle.x * selected.width * scale + inset.x, y: handle.y * selected.height * scale + inset.y };
  }) : [];
  const compactResize = handleCenters.some((center, index) => handleCenters.slice(index + 1).some((other) =>
    Math.abs(center.x - other.x) < hitSize + 4 && Math.abs(center.y - other.y) < hitSize + 4));
  return <section className="preview-panel" aria-label="Layout preview">
    <h2 className="visually-hidden">Canvas</h2>
    <div className="stage-bar">{stageControls}<button className="canvas-size-button" disabled={gesturing} onClick={onResizeCanvas} aria-label="Change canvas size" title="Change canvas size">{document.canvas.width} × {document.canvas.height}</button></div>
    <div className="canvas-stage">
    <div className={`canvas-viewport${gesturing ? ' gesturing' : ''}${space ? ' pan-ready' : ''}${fileHover ? ' file-hover' : ''}`} ref={viewportRef} tabIndex={0} aria-label="Canvas viewport"
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = gesturing ? 'none' : 'copy'; setFileHover(!gesturing); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileHover(false); }}
      onDrop={(event) => { event.preventDefault(); setFileHover(false); if (!gesturing && event.dataTransfer.files.length) onImportWidgets([...event.dataTransfer.files]); }}
      onPointerDownCapture={(event) => { if ((event.button === 1 || (event.button === 0 && spaceRef.current)) && event.isPrimary && scale > 0) capture(event, 'pan'); }}
      onPointerMove={move} onPointerUp={(event) => { if (event.pointerId === gestureRef.current?.pointerId) { move(event); finish(); } }}
      onPointerCancel={(event) => { if (event.pointerId === gestureRef.current?.pointerId) finish(true); }}
      onLostPointerCapture={(event) => { if (event.pointerId === gestureRef.current?.pointerId && event.target === gestureRef.current.target) finish(true); }}
      onKeyDown={(event) => { if (gestureRef.current && event.key !== 'Escape' && event.code !== 'Space') { event.preventDefault(); event.stopPropagation(); } }}>
      <div className={`document-canvas${bitmap ? ' rendered-canvas' : ''}`} data-testid="document-canvas" style={{ ...paletteStyle(palette), color: 'var(--text)', width: document.canvas.width, height: document.canvas.height, left: offsetX, top: offsetY, transform: `scale(${scale})` }}>
        {bitmap ? <img className="rendered-frame" src={bitmap} alt={previewNotice?.includes('Live') || previewNotice?.includes('live') ? 'Panel renderer with live readings' : 'Panel renderer with sample data'} draggable={false} /> : document.chrome !== 'none' && <div className="dashboard-header" aria-hidden="true"><div><span className="card-kicker">TURZX / desktop</span><strong>{dashboardHeading(document)}</strong></div>{!document.widgets.some((widget) => widget.type === 'clock') && <div className="dashboard-time">10:24<span>Sunday, 4 October</span></div>}</div>}
        {document.widgets.map((widget) => <div key={widget.id} tabIndex={0} role="group" aria-label={`${widgetLabel(widget)} card`} aria-roledescription="movable card"
          data-widget-id={widget.id} data-selected={selectedIds.includes(widget.id)} data-primary={selectedId === widget.id}
          className={`dashboard-card ${selectedIds.includes(widget.id) ? 'selected' : ''}${widget.type === 'image' ? ' image-card' : ''}${selectedId === widget.id && activeElement ? ' element-targeted' : ''}`}
          onFocus={() => { if (!suppressFocus.current) onSelect(widget.id, false, true); }} onPointerDown={(event) => begin(event, widget, 'move')}
          onDoubleClick={(event) => {
            // Pointer capture retargets clicks to the card; resolve the text under the pointer too.
            const element = [...event.currentTarget.querySelectorAll<SVGRectElement>('[data-element-target]')].reverse().find((target) => {
              const box = target.getBoundingClientRect();
              return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
            })?.dataset.elementTarget;
            if (element && !event.shiftKey && !spaceRef.current) { event.preventDefault(); event.stopPropagation(); onSelectElement(widget.id, element); }
          }}
          style={{ ...widgetColorStyle(widget), color: 'var(--text)', left: widget.x, top: widget.y, width: widget.width, height: widget.height, '--selection-width': `${2 / (scale || 1)}px` } as CSSProperties}>
          {!bitmap && <CardContent widget={widget} />}
          <ElementTargets widget={widget} active={selectedId === widget.id ? activeElement ?? null : null} scale={scale} />
          {selectedId === widget.id && designElement && <DesignMarker widget={widget} element={designElement} active={Boolean(activeElement)} />}
          {selectedId === widget.id && selectedIds.length === 1 && <>
            <span className="selection-label" aria-hidden="true">{movingElement ? `${movingElement.name} / X offset ${widget.design?.elements?.[activeElement!]?.dx ?? 0} / Y offset ${widget.design?.elements?.[activeElement!]?.dy ?? 0}` : `${widget.width} × ${widget.height}`}</span>
            {!activeElement && (compactResize ? handles.filter((handle) => handle.id === (focusedHandle ?? gestureRef.current?.handle ?? 'se')) : handles).map((handle) => <button key={handle.id} className="resize-handle directional" data-resize-handle={handle.id} type="button"
              aria-label={handle.id === 'se' ? `Resize ${widgetLabel(widget)}` : `Resize ${widgetLabel(widget)} ${handle.name}`}
              title={`Resize ${handle.name}. Arrows 1 px, Shift 10 px.`}
              style={{
                left: `calc(${handle.x * 100}% + ${handleInset(widget, handle).x / (scale || 1)}px)`,
                top: `calc(${handle.y * 100}% + ${handleInset(widget, handle).y / (scale || 1)}px)`,
                cursor: handle.cursor, width: hitSize / (scale || 1), height: hitSize / (scale || 1), '--handle-visual': `${10 / (scale || 1)}px`,
              } as CSSProperties}
              onFocus={() => setFocusedHandle(handle.id)} onBlur={() => setFocusedHandle(null)}
              onPointerDown={(event) => begin(event, widget, 'resize', handle.id)}
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || gestureRef.current) return;
                const step = event.shiftKey ? 10 : 1;
                const directions: Record<string, [number, number]> = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowDown: [0, step], ArrowUp: [0, -step] };
                if (directions[event.key]) {
                  event.preventDefault(); event.stopPropagation();
                  onChange((current) => {
                    const [dx, dy] = directions[event.key];
                    const { x, y, width, height } = resizeFromHandle(current, widget.id, handle.id, dx, dy);
                    return { ...current, widgets: current.widgets.map((entry) => entry.id === widget.id ? { ...entry, x, y, width, height } : entry) };
                  });
                }
              }} />)}
          </>}
        </div>)}
        {guides.map((guide) => <div key={`${guide.axis}:${guide.position}`} className={`snap-guide ${guide.axis}`} data-testid="snap-guide" aria-hidden="true" style={{ [guide.axis === 'x' ? 'left' : 'top']: guide.position, '--guide-width': `${1 / (scale || 1)}px` } as CSSProperties} />)}
        {document.chrome !== 'none' && <div className="dashboard-footer" aria-hidden="true"><span>{bitmap && previewNotice?.includes('Live readings') ? 'Live readings' : 'Deterministic preview'}</span><span>{document.canvas.width} / {document.canvas.height}</span></div>}
      </div>
      {fileHover && <div className="file-drop-hint">Drop a layout or widget JSON file to review its widgets</div>}
      {gesturing && selected && gestureRef.current?.mode !== 'pan' && <div className="gesture-readout mono" data-testid="gesture-readout">
        {movingElement ? `${movingElement.name} / X offset ${selected.design?.elements?.[activeElement!]?.dx ?? 0} / Y offset ${selected.design?.elements?.[activeElement!]?.dy ?? 0}`
          : `${selected.width} × ${selected.height} px / X ${selected.x} / Y ${selected.y}`}
      </div>}
    </div>
    {selected && <SelectionToolbar toolbarRef={toolbarRef} document={document} widget={selected} ids={selectedIds} style={toolbarPlacement.style} docked={toolbarDocked} busy={gesturing}
      compactResize={compactResize} onResize={() => { onCardDrag(); setResizeOpen(true); }}
      onChange={onChange} onDuplicate={onDuplicate} onDelete={onDelete} onCopy={onCopy} onDetails={onDetails} />}
    </div>
    {resizeOpen && selected && <CompactResize key={selected.id} document={document} widget={selected} onChange={onChange} onClose={() => {
      setResizeOpen(false);
      requestAnimationFrame(() => viewportRef.current?.querySelector<HTMLElement>('[data-primary="true"]')?.focus({ preventScroll: true }));
    }} />}
    <div className="stage-footer" aria-label="Canvas view" role="group" data-alert={Boolean(previewStatus.onPreviewRetry)}>
      <label className="snap-toggle" title="Snap edges, centers and 24 px gutters while moving and resizing"><input type="checkbox" aria-label="Snapping" checked={snapping} onChange={(event) => {
        finish(true); setSnapping(event.target.checked);
        try { localStorage.setItem(SNAP_PREFERENCE, event.target.checked ? 'on' : 'off'); } catch { /* The current tab still keeps the choice. */ }
      }} />Snapping</label>
      {previewControls}
      {/* The slot keeps its size when notes come and go, so a drag never resizes the canvas. */}
      <details className="canvas-warnings" data-empty={warnings.length === 0} aria-hidden={warnings.length === 0 || undefined}><summary tabIndex={warnings.length === 0 ? -1 : undefined}>{warnings.length === 100 ? '100+' : warnings.length} layout {warnings.length === 1 ? 'note' : 'notes'}</summary><div className="canvas-warning-content"><p>Informational. You can still export and save this layout.</p><ul>{warnings.slice(0, 8).map((warning, index) => <li key={index}>{warning.message}</li>)}</ul>{warnings.length > 8 && <p>{warnings.length - 8} more notes. Review overlapping or small cards.</p>}</div></details>
      <span className="preview-notice canvas-status-notice" role={previewStatus.onPreviewRetry ? 'status' : undefined} title={previewStatus.previewNotice}>{previewStatus.previewNotice}{previewStatus.onPreviewRetry && <button className="text-link" onClick={previewStatus.onPreviewRetry}>Retry preview</button>}</span>
      <div className="zoom-controls"><button aria-label="Zoom out" disabled={zoom <= .25} onClick={() => view(zoom / 1.25)}>−</button><span aria-label="Canvas zoom" title={`Scale ${Math.round(scale * 100)}% of panel pixels`}>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" disabled={zoom >= 4} onClick={() => view(zoom * 1.25)}>+</button><button onClick={() => view(1, true)}>Fit</button></div>
      <ShortcutsHelp panel={panelShortcuts} />
    </div>
  </section>;
}
