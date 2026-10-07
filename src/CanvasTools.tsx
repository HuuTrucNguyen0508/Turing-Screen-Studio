import { useEffect, useState } from 'react';
import { alignSelection, distributeSelection, matchSelectionSize, reorderSelection } from './domain/canvas';
import type { Alignment, DistributionAxis, LayerDirection, SizeMatch } from './domain/canvas';
import type { LayoutDocument } from './domain/layout';
import { widgetLabel } from './WidgetContent';

function AlignmentIcon({ mode }: { mode: Alignment }) {
  const horizontal = ['left', 'center', 'right'].includes(mode);
  const line = mode === 'left' || mode === 'top' ? 2 : mode === 'right' || mode === 'bottom' ? 14 : 8;
  const first = line === 2 ? 4 : line === 14 ? 2 : 3;
  const second = line === 2 ? 4 : line === 14 ? 6 : 5;
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d={horizontal ? `M${line} 1v14` : `M1 ${line}h14`} stroke="currentColor" />
    {horizontal ? <><rect x={first} y="4" width="10" height="3" fill="currentColor" /><rect x={second} y="9" width="6" height="3" fill="currentColor" /></>
      : <><rect x="4" y={first} width="3" height="10" fill="currentColor" /><rect x="9" y={second} width="3" height="6" fill="currentColor" /></>}
  </svg>;
}

type Props = {
  document: LayoutDocument;
  selectedIds: readonly string[];
  selectedId: string | null;
  busy: boolean;
  onChange: (document: LayoutDocument) => void;
};

export default function CanvasTools({ document, selectedIds, selectedId, busy, onChange }: Props) {
  const count = selectedIds.length;
  const [error, setError] = useState('');
  const reference = document.widgets.find((widget) => widget.id === selectedId && selectedIds.includes(widget.id));
  const selectionKey = selectedIds.join('\n');
  useEffect(() => { setError(''); }, [document, selectionKey, selectedId]);
  function run(operation: () => LayoutDocument) {
    try { onChange(operation()); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'These cards do not fit.'); }
  }
  return <div className="canvas-tools">
    <span className="selection-count" aria-live="polite">{count} selected</span>
    <fieldset disabled={busy || count < 2}><legend>Align</legend><div>
      {(['left', 'center', 'right', 'top', 'middle', 'bottom'] as Alignment[]).map((mode) => <button key={mode} aria-label={`Align ${mode}`} title={`Align ${mode} within selection`} onClick={() => run(() => alignSelection(document, selectedIds, mode))}><AlignmentIcon mode={mode} /></button>)}
    </div></fieldset>
    <fieldset disabled={busy || count < 2 || !reference}><legend>Size</legend><div>
      {(['width', 'height', 'both'] as SizeMatch[]).map((mode) => <button key={mode}
        title={reference ? `Match ${widgetLabel(reference)}${mode === 'both' ? ' size' : ` ${mode}`}` : 'Select two or more cards'}
        onClick={() => run(() => matchSelectionSize(document, selectedIds, reference!.id, mode))}>
        {mode === 'both' ? 'Same size' : `Same ${mode}`}
      </button>)}
    </div></fieldset>
    <fieldset disabled={busy || count < 2}><legend>Distribute</legend><div>
      {(['horizontal', 'vertical'] as DistributionAxis[]).map((axis) => <span key={axis} className="tool-pair"><button disabled={count < 3} aria-label={`Distribute ${axis} evenly`} title={`Even ${axis} gaps`} onClick={() => run(() => distributeSelection(document, selectedIds, axis))}>{axis === 'horizontal' ? 'H' : 'V'} even</button><button aria-label={`Distribute ${axis} 24 px`} title={`24 px ${axis} gaps`} onClick={() => run(() => distributeSelection(document, selectedIds, axis, 24))}>24 px</button></span>)}
    </div></fieldset>
    <fieldset disabled={busy || !count}><legend>Layer</legend><div>
      {(['back', 'backward', 'forward', 'front'] as LayerDirection[]).map((mode) => <button key={mode} aria-label={`Send ${mode}`} title={`Send selection ${mode}`} onClick={() => run(() => reorderSelection(document, selectedIds, mode))}>{mode}</button>)}
    </div></fieldset>
    {count > 1 && reference && <p className="size-reference">Size reference: <strong>{widgetLabel(reference)}</strong> <span className="mono">{reference.width} × {reference.height} px</span><span>Choose a selected card to change the reference.</span></p>}
    {error && <p className="canvas-tool-error" role="status">{error}</p>}
  </div>;
}
