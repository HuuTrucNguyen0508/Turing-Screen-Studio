import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, KeyboardEvent, SetStateAction } from 'react';
import CanvasPreview, { widgetLabel } from './CanvasPreview';
import usePanel from './usePanel';
import { createSampleLayout, moveWidget, parseCaelestiaPalette, parseLayout, serializeLayout, updateGeometry } from './domain/layout';
import type { Geometry, LayoutDocument, Palette, MetricSource } from './domain/layout';

const geometryLabels: Record<keyof Geometry, string> = { x: 'X position', y: 'Y position', width: 'Width', height: 'Height' };

function paletteStyle(palette: Palette): CSSProperties {
  return Object.fromEntries(Object.entries(palette).filter(([key]) => key !== 'name').map(([key, value]) => [`--${key}`, value])) as CSSProperties;
}

function GeometryField({ field, value, max, onCommit }: { field: keyof Geometry; value: number; max: number; onCommit: (value: number) => void }) {
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
      inputMode="numeric" value={draft} aria-invalid={Boolean(error)} aria-describedby={error ? `error-${field}` : undefined}
      onChange={(event) => { setDraft(event.target.value); setError(''); }} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape') { event.stopPropagation(); setDraft(String(value)); setError(''); }
      }} /><span>px</span></div>
    {error && <span id={`error-${field}`} className="field-error">{error}</span>}
  </label>;
}

export default function App() {
  const [document, setDocument] = useState<LayoutDocument>(createSampleLayout);
  const [baseline, setBaseline] = useState(() => serializeLayout(createSampleLayout()));
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => createSampleLayout().widgets[0]?.id ?? null);
  const [message, setMessage] = useState('Sample layout ready.');
  const [error, setError] = useState('');
  const [pendingImport, setPendingImport] = useState<{ document: LayoutDocument; panelRevision?: string } | null>(null);
  const [documentGeneration, setDocumentGeneration] = useState(0);
  const layoutInput = useRef<HTMLInputElement>(null);
  const paletteInput = useRef<HTMLInputElement>(null);
  const importDialog = useRef<HTMLDialogElement>(null);
  const importSequence = useRef(0);
  const panelDialog = useRef<HTMLDialogElement>(null);
  const [panelImage, setPanelImage] = useState('');
  const serialized = serializeLayout(document);
  const dirty = serialized !== baseline;
  const dirtyRef = useRef(dirty);
  const documentRef = useRef(document);
  documentRef.current = document;
  dirtyRef.current = dirty;
  const selected = document.widgets.find((widget) => widget.id === selectedId);
  const panel = usePanel(document, load, () => dirtyRef.current, (saved, revision) => setPendingImport({ document: saved, panelRevision: revision }));
  const displayPalette = document.paletteMode === 'live' && panel.palette ? panel.palette : document.palette;
  const panelAccepted = Boolean(panel.revision && panel.status.appliedRevision === panel.revision && panel.status.requestedRevision === panel.revision);
  const panelState = !panel.status.runtimeRunning ? 'Runtime offline' : !panel.status.connected ? 'Reconnecting to panel' : panel.status.view === 'speedtest' ? 'Speedtest on panel' : panelAccepted ? 'Panel accepted frame' : 'Waiting for panel';

  async function saveToPanel() {
    const snapshot = parseLayout(serializeLayout(documentRef.current));
    try {
      const revision = await panel.save(snapshot);
      if (revision) { setBaseline(serializeLayout(snapshot)); setLastExport(null); setError(''); setMessage('Layout saved. Waiting for the panel to accept a frame.'); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save to panel.'); }
  }

  async function openPanelLayout() {
    try { const next = await panel.openSaved(); if (dirtyRef.current) setPendingImport({ document: next.document, panelRevision: next.revision }); else load(next.document, next.revision); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not open the saved layout.'); }
  }

  function setSource(value: string) {
    if (!selected) return;
    change((current) => ({ ...current, widgets: current.widgets.map((widget) => widget.id !== selected.id ? widget : widget.type === 'metric'
      ? { ...widget, settings: { ...widget.settings, source: value as MetricSource } }
      : { ...widget, settings: { ...widget.settings, source: value as 'sample' | 'weather' } }) }));
  }

  useEffect(() => {
    const dialog = importDialog.current!;
    if (pendingImport && !dialog.open) dialog.showModal();
    if (!pendingImport && dialog.open) dialog.close();
  }, [pendingImport]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function change(update: SetStateAction<LayoutDocument>) {
    const next = typeof update === 'function' ? update(documentRef.current) : update;
    documentRef.current = next;
    setDocument(next);
  }

  function load(next: LayoutDocument, panelRevision?: string) {
    if (panelRevision) panel.adoptSaved(panelRevision);
    setDocumentGeneration((generation) => generation + 1);
    change(next); setBaseline(serializeLayout(next)); setLastExport(null);
    setSelectedId(next.widgets[0]?.id ?? null); setPendingImport(null);
    setError(''); setMessage(`Opened ${next.name}.`);
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>, kind: 'layout' | 'palette') {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const sequence = ++importSequence.current;
    try {
      if (file.size > 1024 * 1024) throw new Error('Choose a JSON file smaller than 1 MB.');
      const text = await file.text();
      if (sequence !== importSequence.current) return;
      if (kind === 'layout') {
        const next = parseLayout(text);
        if (dirtyRef.current) setPendingImport({ document: next });
        else load(next);
      } else {
        const palette = parseCaelestiaPalette(text);
        change((current) => ({ ...current, palette, ...(panel.available ? { paletteMode: 'saved' as const } : {}) }));
        setError(''); setMessage(`Imported ${palette.name} palette. Export to keep it with this layout.`);
      }
    } catch (failure) {
      if (sequence !== importSequence.current) return;
      setError(`Could not import ${kind}. ${failure instanceof Error ? failure.message : 'Choose a valid JSON file.'}`);
    }
  }

  function exportLayout() {
    const exportText = serializeLayout(documentRef.current);
    const url = URL.createObjectURL(new Blob([exportText], { type: 'application/json' }));
    const link = window.document.createElement('a');
    link.href = url; link.download = `${document.name.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || 'turzx-layout'}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setLastExport(exportText); setError(''); setMessage('Download requested. Reopen the saved JSON to confirm it and clear the unsaved warning.');
  }

  function nudge(event: KeyboardEvent<HTMLElement>) {
    if (!selected || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (!target.closest('[data-widget-id]') || target.closest('input, textarea, select, button')) return;
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    const multiplier = event.shiftKey ? 10 : 1;
    change((current) => moveWidget(current, selected.id, step[0] * multiplier, step[1] * multiplier));
  }

  return <main className="studio" style={paletteStyle(displayPalette)} onKeyDown={nudge}>
    <header className="app-header">
      <a className="brand" href="#" onClick={(event) => event.preventDefault()} aria-label="TURZX Studio"><span className="brand-symbol" aria-hidden="true">T</span><span>TURZX<span className="brand-light"> Studio</span></span></a>
      <div className="mode-badge"><span className="status-dot" />{panel.available ? 'Panel editor' : 'Offline editor'}</div>
      <div className="header-actions"><button onClick={() => layoutInput.current?.click()}>Open layout</button><button onClick={exportLayout} className={panel.available ? '' : 'primary-button'}>Export JSON <span aria-hidden="true">↗</span></button>{panel.available && <button className="primary-button" disabled={panel.saving || panel.openingSaved || !panel.revision} onClick={() => void saveToPanel()}>{panel.saving ? 'Saving…' : 'Save to panel'}</button>}</div>
      <input ref={layoutInput} type="file" accept=".json,application/json" hidden aria-label="Open layout file" onChange={(event) => void importFile(event, 'layout')} />
      <input ref={paletteInput} type="file" accept=".json,application/json" hidden aria-label="Import palette file" onChange={(event) => void importFile(event, 'palette')} />
    </header>
    <div className="document-bar"><div><span className="eyebrow">Layout document</span><h1>{document.name}</h1></div><div className="document-indicators">{panel.available && <span className="panel-status" role="status">{panelState}</span>}<span className={`document-status${dirty ? ' dirty' : ''}`} data-testid="document-status">{dirty ? lastExport === serialized ? 'Export requested' : 'Unsaved changes' : 'No unsaved changes'}</span></div></div>
    {panel.available && !panel.revision && <p className="panel-note">Export your draft, then open the saved layout to enable Save to panel. You can reopen your exported draft afterwards.</p>}
    <div className="workspace">
      <aside className="widget-panel" aria-label="Widgets">
        <div className="panel-heading"><h2>Widgets</h2><span className="count-badge">{document.widgets.length}</span></div>
        <p className="panel-note">Select a card to adjust its position.</p>
        <div className="widget-list">{document.widgets.map((widget) => <button key={widget.id} className={`widget-row${selectedId === widget.id ? ' active' : ''}`}
          aria-pressed={selectedId === widget.id} onClick={() => setSelectedId(widget.id)}>
          <span className="widget-icon" aria-hidden="true">{widget.type === 'metric' ? '▤' : '☀'}</span>
          <span><strong>{widgetLabel(widget)}</strong><small>{widget.type} card</small></span><span className="widget-row-mark" aria-hidden="true">↗</span>
        </button>)}</div>
        {document.widgets.length === 0 && <p className="panel-note">This layout has no widgets. Open a layout with cards to edit them.</p>}
        <div className="palette-section"><span className="eyebrow">Preview palette</span><h3>Caelestia</h3><div className="swatches" aria-label={`${document.palette.name} palette`}>
          {(['background', 'surface', 'primary', 'secondary', 'text'] as const).map((key) => <span key={key} title={`${key} ${document.palette[key]}`} style={{ background: document.palette[key] }} />)}
        </div><p className="panel-note">{displayPalette.name}<br />{document.paletteMode === 'live' ? 'Following the desktop scheme.' : 'Stored with this layout.'}</p>{panel.available && <label className="theme-choice"><input type="checkbox" checked={document.paletteMode === 'live'} onChange={(event) => change((current) => ({ ...current, paletteMode: event.target.checked ? 'live' : 'saved' }))} /> Follow desktop colours</label>}<button className="text-button" onClick={() => paletteInput.current?.click()}>Import scheme.json <span aria-hidden="true">↗</span></button></div>
        <div className="offline-note"><span className="status-dot" /><div><strong>{panel.available ? 'Panel connection' : 'Preview only'}</strong><p>{panel.available ? panel.status.error || 'Canvas uses sample data. Panel uses selected sources.' : 'Sample data. No panel connection.'}</p>{panel.available && <><button className="text-button" disabled={panel.saving || panel.openingSaved} onClick={() => void openPanelLayout()}>Open saved layout</button><button className="text-button" onClick={() => { setPanelImage(`/api/frame?t=${Date.now()}`); panelDialog.current?.showModal(); }}>View panel frame</button></>}</div></div>
      </aside>
      <CanvasPreview key={documentGeneration} document={document} selectedId={selectedId} onSelect={setSelectedId} onChange={change} getDocument={() => documentRef.current} bitmap={panel.preview} />
      <aside className="inspector-panel" aria-label="Inspector"><div className="panel-heading"><h2>Inspector</h2><span className="mono">px</span></div>
        {selected ? <div key={`${documentGeneration}:${selected.id}`}>
          <div className="selected-widget"><span className="eyebrow">{selected.type} card</span><h3>{widgetLabel(selected)}</h3><span className="mono widget-id">{selected.id}</span></div>
          <div className="inspector-section"><h4>Position & size</h4><div className="geometry-grid">
            {(Object.keys(geometryLabels) as (keyof Geometry)[]).map((field) => <GeometryField key={field} field={field} value={selected[field]}
              max={field === 'x' ? document.canvas.width - selected.width : field === 'y' ? document.canvas.height - selected.height : field === 'width' ? document.canvas.width - selected.x : document.canvas.height - selected.y}
              onCommit={(value) => change((current) => updateGeometry(current, selected.id, { [field]: value }))} />)}
          </div><p className="panel-note">Whole pixels only. Values stay inside the canvas.</p></div>
          <div className="inspector-section"><h4>Panel data</h4><label className="source-field">Source<select aria-label="Panel data source" value={selected.settings.source ?? 'sample'} onChange={(event) => setSource(event.target.value)}>{(selected.type === 'metric' ? ['sample', 'cpu', 'gpu', 'memory', 'disk', 'network-down', 'network-up'] : ['sample', 'weather']).map((source) => <option key={source} value={source}>{source}</option>)}</select></label><p className="panel-note">The canvas stays deterministic. Live values appear on the panel after saving.</p></div>
          <div className="inspector-section"><h4>Sample content</h4><dl className="settings-list">{Object.entries(selected.settings).filter(([key]) => key !== 'source').map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></div>
          <div className="keyboard-note"><span className="eyebrow">Fine adjustments</span><p>Focus a card, then use the arrow keys.</p><div><kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd><span>1 px</span></div><p>Hold <kbd>Shift</kbd> for 10 px.</p></div>
        </div> : <p className="panel-note">Select a card on the canvas or in the widget list.</p>}
      </aside>
    </div>
    <footer className="app-footer"><span role="status" aria-live="polite">{message}</span><span className="mono">Layout v{document.version} · Sample data</span></footer>
    {(error || panel.previewError) && <div className="error-banner" role="alert"><span>{error || panel.previewError}</span><button aria-label="Dismiss import error" onClick={() => setError('')}>×</button></div>}
    <dialog ref={panelDialog} className="panel-frame-dialog"><h2>Last accepted panel frame</h2><p>{panel.status.frameTime ? `Captured ${new Date(panel.status.frameTime * 1000).toLocaleTimeString()}.` : 'No captured frame yet.'} Captures update at most every 10 seconds. This shows the frame before the USB rotation.</p><img src={panelImage || undefined} alt="Last frame accepted by the panel" /><button onClick={() => panelDialog.current?.close()}>Close</button></dialog>
    <dialog ref={importDialog} className="import-dialog" aria-labelledby="import-title" onCancel={(event) => { event.preventDefault(); setPendingImport(null); }}>
      {pendingImport && <>
      <h2 id="import-title">Replace unsaved changes?</h2><p>Opening {pendingImport.document.name} replaces your current layout. Export your changes first if you want to keep them.</p>
      <div><button autoFocus onClick={() => setPendingImport(null)}>Keep editing</button><button className="primary-button" onClick={() => load(pendingImport.document, pendingImport.panelRevision)}>Open and discard changes</button></div>
      </>}
    </dialog>
  </main>;
}
