import { useEffect, useRef, useState } from 'react';
import type { LayoutDocument, Widget } from './domain/layout';
import { resizeFromHandle } from './domain/canvas';
import type { ResizeHandle } from './domain/canvas';
import { widgetLabel } from './WidgetContent';

export default function CompactResize({ document, widget, onChange, onClose }: {
  document: LayoutDocument; widget: Widget; onChange: (document: LayoutDocument) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [handle, setHandle] = useState<ResizeHandle>('se');
  const [step, setStep] = useState(1);
  useEffect(() => { dialog.current?.showModal(); }, []);
  function resize(dx: number, dy: number) {
    const { x, y, width, height } = resizeFromHandle(document, widget.id, handle, dx * step, dy * step);
    onChange({ ...document, widgets: document.widgets.map((entry) => entry.id === widget.id ? { ...entry, x, y, width, height } : entry) });
  }
  return <dialog ref={dialog} className="compact-resize-dialog" aria-labelledby="compact-resize-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="panel-heading"><h2 id="compact-resize-title">Resize {widgetLabel(widget)}</h2><button aria-label="Close resize" onClick={onClose}>×</button></div>
    <p>Choose an edge or corner. The opposite edge stays fixed.</p>
    <fieldset className="resize-edge-grid"><legend>Resize from</legend>
      {([['nw', 'Top left'], ['n', 'Top'], ['ne', 'Top right'], ['w', 'Left'], ['e', 'Right'], ['sw', 'Bottom left'], ['s', 'Bottom'], ['se', 'Bottom right']] as const).map(([id, label]) =>
        <label key={id} data-handle={id}><input type="radio" name="resize-edge" value={id} checked={handle === id} onChange={() => setHandle(id)} />{label}</label>)}
    </fieldset>
    <fieldset className="resize-step"><legend>Step</legend>{[1, 10].map((value) => <label key={value}><input type="radio" name="resize-step" checked={step === value} onChange={() => setStep(value)} />{value} px</label>)}</fieldset>
    <div className="resize-pad" role="group" aria-label="Resize directions">{([['left', '←', -1, 0], ['up', '↑', 0, -1], ['down', '↓', 0, 1], ['right', '→', 1, 0]] as const).map(([direction, glyph, dx, dy]) =>
      <button key={direction} aria-label={`Resize toward ${direction}`} disabled={dx ? !handle.includes('w') && !handle.includes('e') : !handle.includes('n') && !handle.includes('s')} onClick={() => resize(dx, dy)}>{glyph}</button>)}
    </div>
    <p className="mono" role="status">{widget.width} × {widget.height} px / X {widget.x} / Y {widget.y}</p>
    <button className="primary-button" onClick={onClose}>Done</button>
  </dialog>;
}
