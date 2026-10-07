import { useEffect, useRef, useState } from 'react';
import type { LayoutDocument } from './domain/layout';
import { resizeCanvas, type CanvasResizeMode } from './domain/canvasSize';
import { StaticLayout } from './WidgetContent';
import './canvas-size.css';

const sizes = [[480, 320], [320, 480], [480, 480], [800, 480], [1280, 800], [1920, 480]];

export default function CanvasSize({ document, available, onClose, onResize }: {
  document: LayoutDocument; available: boolean; onClose: () => void; onResize: (next: LayoutDocument) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [width, setWidth] = useState(String(document.canvas.width));
  const [height, setHeight] = useState(String(document.canvas.height));
  const [mode, setMode] = useState<CanvasResizeMode>('fit');
  useEffect(() => { dialog.current?.showModal(); }, []);
  let next: LayoutDocument | null = null;
  let error = '';
  try {
    if (!/^\d+$/.test(width) || !/^\d+$/.test(height)) throw new Error('Enter whole pixel dimensions.');
    next = resizeCanvas(document, Number(width), Number(height), mode);
  } catch (failure) { error = failure instanceof Error ? failure.message : 'Check the canvas size.'; }
  const outside = document.widgets.filter(card => card.x + card.width > Number(width) || card.y + card.height > Number(height)).length;
  const preset = sizes.some(size => `${size[0]}x${size[1]}` === `${width}x${height}`) ? `${width}x${height}` : '';
  return <dialog ref={dialog} className="catalog-dialog canvas-size-dialog" aria-labelledby="canvas-size-title" onCancel={onClose} onClose={onClose}>
    <div className="panel-heading"><h2 id="canvas-size-title">Canvas size</h2><button aria-label="Close canvas size" onClick={onClose}>×</button></div>
    <label className="canvas-size-presets">Screen size presets, layout size only<select value={preset} onChange={event => {
      if (!event.target.value) return;
      const [w, h] = event.target.value.split('x'); setWidth(w); setHeight(h);
    }}><option value="">Custom</option>{sizes.map(([w, h]) => <option key={`${w}x${h}`} value={`${w}x${h}`}>{w} × {h} px</option>)}</select></label>
    <div className="canvas-dimensions">
      <label className="geometry-field">Canvas width<div className="input-with-unit"><input autoFocus aria-label="Canvas width" aria-invalid={Boolean(error)} aria-describedby={error ? 'canvas-size-error' : undefined} inputMode="numeric" value={width} onChange={event => setWidth(event.target.value)} /><span>px</span></div></label>
      <button aria-label="Swap width and height" onClick={() => { setWidth(height); setHeight(width); }}>⇄</button>
      <label className="geometry-field">Canvas height<div className="input-with-unit"><input aria-label="Canvas height" aria-invalid={Boolean(error)} aria-describedby={error ? 'canvas-size-error' : undefined} inputMode="numeric" value={height} onChange={event => setHeight(event.target.value)} /><span>px</span></div></label>
    </div>
    <fieldset className="canvas-resize-modes"><legend>Cards</legend>
      <label><input type="radio" name="resize-mode" checked={mode === 'fit'} onChange={() => setMode('fit')} />Fit cards, preserving their proportions</label>
      <label><input type="radio" name="resize-mode" checked={mode === 'keep'} disabled={outside > 0} onChange={() => setMode('keep')} />Keep positions{outside > 0 && <span className="panel-note">{outside} cards would be outside the canvas.</span>}</label>
      <label><input type="radio" name="resize-mode" checked={mode === 'empty'} onChange={() => setMode('empty')} />Start with an empty canvas</label>
    </fieldset>
    {next && <div className="canvas-size-result"><StaticLayout document={next} maxHeight={200} /><span className="mono">{width} × {height} px · {next.widgets.length} cards</span></div>}
    {error && <p id="canvas-size-error" role="alert" className="field-error">{error}</p>}
    <p className="panel-note">Text sizes stay the same. Small cards may need editing. Undo restores the previous size and cards.</p>
    {document.chrome !== 'none' && (Number(width) < 1280 || Number(height) < 800) && <p className="panel-note">The header and footer are sized for 1280 × 800 and may cover cards.</p>}
    {available && (Number(width) !== 1280 || Number(height) !== 800) && <p className="panel-note">Panel saves need 1280 × 800. Export JSON to keep this draft.</p>}
    <div className="canvas-size-actions"><button onClick={onClose}>Keep current size</button><button className="primary-button" disabled={!next} onClick={() => { if (next) { onResize(next); onClose(); } }}>{mode === 'empty' ? 'Clear and resize' : 'Resize canvas'}</button></div>
  </dialog>;
}
