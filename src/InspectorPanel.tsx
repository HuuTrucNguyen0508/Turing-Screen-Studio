import { useEffect, useState } from 'react';
import type { SetStateAction } from 'react';
import InspectorSection from './InspectorSection';
import CanvasTools from './CanvasTools';
import ContentEditor from './ContentEditor';
import DesignEditor from './DesignEditor';
import MovementControls from './MovementControls';
import { WidgetColorEditor } from './ColorEditor';
import { widgetLabel } from './WidgetContent';
import { effectiveWidgetPalette } from './domain/colors';
import { updateWidgetDesign } from './domain/design';
import { updateGeometry } from './domain/layout';
import type { Geometry, LayoutDocument, Palette, Widget } from './domain/layout';
import { sourceLabels, updateWidgetSettings, widgetSources } from './domain/widgets';

const geometryLabels: Record<keyof Geometry, string> = { x: 'X position', y: 'Y position', width: 'Width', height: 'Height' };

function GeometryField({ field, value, max, onCommit, disabled = false }: { field: keyof Geometry; value: number; max: number; disabled?: boolean; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(String(value)); setError(''); }, [value]);
  const min = field === 'width' || field === 'height' ? 1 : 0;
  function commit() {
    const number = Number(draft);
    if (!/^\d+$/.test(draft) || !Number.isSafeInteger(number)) {
      setError('Enter a whole number.');
    } else if (number < min || number > max) {
      setError(`Use ${min} to ${max} px.`);
    } else {
      setError(''); setDraft(String(number)); onCommit(number);
    }
  }
  return <label className="geometry-field">{geometryLabels[field]}
    <div className={`input-with-unit${error ? ' invalid' : ''}`}><input aria-label={geometryLabels[field]}
      disabled={disabled} inputMode="numeric" value={draft} aria-invalid={Boolean(error)} aria-describedby={error ? `error-${field}` : undefined}
      onChange={(event) => { setDraft(event.target.value); setError(''); }} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape') { event.stopPropagation(); setDraft(String(value)); setError(''); }
        if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.altKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          const base = /^\d+$/.test(draft) ? Number(draft) : NaN;
          if (!Number.isSafeInteger(base) || base < min || base > max) { setError(`Use a whole number from ${min} to ${max} px.`); return; }
          const step = (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1);
          const next = Math.min(max, Math.max(min, base + step));
          setDraft(String(next)); setError(''); if (next !== value) onCommit(next);
        }
      }} /><span>px</span></div>
    {error && <span id={`error-${field}`} className="field-error">{error}</span>}
  </label>;
}

export default function InspectorPanel({ document, selected, selectedIds, palette, activeElement, busy, generation, customBusy, onChange, onMoveTarget, onNudge, onInspect, onSaveCustom, onGameTimers, onHide, hidden }: {
  document: LayoutDocument; selected?: Widget; selectedIds: readonly string[]; palette: Palette; activeElement: string | null;
  busy: boolean; generation: number; customBusy: boolean;
  onChange: (update: SetStateAction<LayoutDocument>) => void;
  onMoveTarget: (element: string | null) => void; onNudge: (dx: number, dy: number) => void; onInspect: (element: string | null) => void;
  onSaveCustom: () => void; onGameTimers: () => void; onHide: () => void; hidden: boolean;
}) {
  return <aside id="inspector-panel" className="inspector-panel side-panel" aria-label="Inspector" tabIndex={-1} hidden={hidden}>
    <div className="side-heading">
      <h2>Inspector</h2>
      <button className="panel-close" aria-label="Hide Inspector" aria-expanded="true" aria-controls="inspector-panel" disabled={busy} onClick={onHide}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14"><path d="M5.5 3l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
    </div>
    {selected ? <div key={`${generation}:${selected.id}`}>
      <div className="selected-widget">
        <h3>{selectedIds.length > 1 ? `${selectedIds.length} cards` : widgetLabel(selected)}</h3>
        <p>{selectedIds.length > 1 ? <>Fields edit {widgetLabel(selected)}, the size reference.</> : <>{selected.type} card <span className="widget-id">{selected.id}</span></>}</p>
      </div>
      <InspectorSection id="geometry" title="Position and size"><div className="geometry-grid">
        {(Object.keys(geometryLabels) as (keyof Geometry)[]).map((field) => <GeometryField key={field} field={field} value={selected[field]} disabled={selectedIds.length > 1 && (field === 'width' || field === 'height')}
          max={field === 'x' ? document.canvas.width - selected.width : field === 'y' ? document.canvas.height - selected.height : field === 'width' ? document.canvas.width - selected.x : document.canvas.height - selected.y}
          onCommit={(value) => onChange((current) => updateGeometry(current, selected.id, { [field]: value }))} />)}
      </div>
        <MovementControls widget={selected} count={selectedIds.length} element={activeElement} onTarget={onMoveTarget} onNudge={onNudge} busy={busy} />
      </InspectorSection>
      <InspectorSection id="arrange" title="Arrange"><CanvasTools document={document} selectedIds={selectedIds} selectedId={selected.id} busy={busy} onChange={onChange} /></InspectorSection>
      {selected.type !== 'text' && selected.type !== 'image' && selected.type !== 'list' && selected.type !== 'graph' && <InspectorSection id="data" title="Panel data">
        <label className="source-field">Source<select aria-label="Panel data source" value={selected.settings.source ?? 'sample'} onChange={(event) => onChange((current) => updateWidgetSettings(current, selected.id, { source: event.target.value }))}>{widgetSources(selected).map((source) => <option key={source} value={source}>{sourceLabels[source]}</option>)}</select></label>
        {selected.type === 'storage' && <p className="panel-note">Physical drives combine mounted partition usage against the drive's full capacity. The partitions view can show selected mount paths. Shared filesystems are counted once.</p>}
        {selected.type === 'gauge' && <p className="panel-note">Memory gauges use %. Network gauges use KB/s.</p>}
        {selected.type === 'metric' && selected.settings.source === 'game-resources' && <button onClick={onGameTimers}>Set game timers</button>}
      </InspectorSection>}
      <ContentEditor widget={selected} onCommit={(patch) => onChange((current) => updateWidgetSettings(current, selected.id, patch))} />
      <WidgetColorEditor document={document} widget={selected} palette={palette} onChange={onChange} />
      <DesignEditor widget={selected} palette={effectiveWidgetPalette(palette, selected)} onInspect={onInspect} onMove={onMoveTarget} onCommit={(patch) => onChange((current) => updateWidgetDesign(current, selected.id, patch))} />
      <div className="inspector-section keep-section"><h4>Reuse</h4>
        <p className="panel-note">To move this card to another layout, use Copy in the selection actions, open the other layout and paste. To keep it in Add widget for good, save it as a custom widget.</p>
        <button disabled={customBusy} onClick={onSaveCustom}>Save as custom widget…</button>
      </div>
    </div> : <p className="panel-note">Select a card on the canvas or in Layers.</p>}
  </aside>;
}
