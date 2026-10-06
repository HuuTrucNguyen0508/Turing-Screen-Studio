import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, KeyboardEvent, SetStateAction } from 'react';
import CanvasPreview, { widgetLabel } from './CanvasPreview';
import usePanel from './usePanel';
import ContentEditor, { ContentField } from './ContentEditor';
import { StaticLayout } from './WidgetContent';
import WidgetLibrary from './WidgetLibrary';
import SavedLayouts from './SavedLayouts';
import type { LayoutSelection } from './SavedLayouts';
import { addWidget, duplicateWidget, parseLayoutPresets, removeWidget, sourceLabels, updateWidgetSettings, widgetCatalog, widgetGroups, widgetSources } from './domain/widgets';
import type { LayoutPreset } from './domain/widgets';
import { createSampleLayout, moveWidget, parseCaelestiaPalette, parseLayout, serializeLayout, updateGeometry } from './domain/layout';
import type { Geometry, LayoutDocument, Palette } from './domain/layout';

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
  const [pendingImport, setPendingImport] = useState<{ document: LayoutDocument; panelRevision?: string; preset?: boolean } | null>(null);
  const [presets, setPresets] = useState<LayoutPreset[]>([]);
  const [presetError, setPresetError] = useState('');
  const [undoRemoval, setUndoRemoval] = useState<{ document: LayoutDocument; selectedId: string } | null>(null);
  const [documentGeneration, setDocumentGeneration] = useState(0);
  const layoutInput = useRef<HTMLInputElement>(null);
  const paletteInput = useRef<HTMLInputElement>(null);
  const importDialog = useRef<HTMLDialogElement>(null);
  const importSequence = useRef(0);
  const panelDialog = useRef<HTMLDialogElement>(null);
  const catalogDialog = useRef<HTMLDialogElement>(null);
  const presetsDialog = useRef<HTMLDialogElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
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
  const panelChangedElsewhere = panel.revision && panel.status.requestedRevision && panel.status.requestedRevision !== panel.revision;
  const panelState = !panel.status.runtimeRunning ? 'Runtime offline' : !panel.status.connected ? 'Reconnecting to panel' : panel.status.view === 'speedtest' ? 'Speedtest on panel' : panelChangedElsewhere ? 'Panel layout changed elsewhere' : panelAccepted ? 'Panel accepted frame' : 'Waiting for panel';

  async function switchPanelLayout(selection: LayoutSelection) {
    const result = await panel.switchLayout(selection);
    if (!result) return null;
    setError('');
    setMessage(`Switched panel to ${result.document.name}. Waiting for an accepted frame. Your editor draft is unchanged. Use Open saved layout to view the panel's dashboard.`);
    return result;
  }

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
    change((current) => updateWidgetSettings(current, selected.id, { source: value }));
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/layout-presets.json', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Ready-made layouts could not be loaded. Reopen the editor to try again.');
      setPresets(parseLayoutPresets(await response.json()));
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setPresetError(failure instanceof Error ? failure.message : 'Ready-made layouts could not be loaded.'); });
    return () => controller.abort();
  }, []);

  function focusCard(id: string) {
    requestAnimationFrame(() => [...window.document.querySelectorAll<HTMLElement>('[data-widget-id]')].find((card) => card.dataset.widgetId === id)?.focus({ preventScroll: true }));
  }

  function appendWidget(presetId?: string) {
    const next = presetId ? addWidget(documentRef.current, presetId) : duplicateWidget(documentRef.current, selectedId!);
    const widget = next.widgets[next.widgets.length - 1];
    change(next); setSelectedId(widget.id); catalogDialog.current?.close(); focusCard(widget.id);
    const overlaps = next.widgets.slice(0, -1).some((other) => widget.x < other.x + other.width && widget.x + widget.width > other.x && widget.y < other.y + other.height && widget.y + widget.height > other.y);
    setMessage(`${presetId ? 'Added' : 'Duplicated'} ${widgetLabel(widget)}.${overlaps ? ' It overlaps another card; drag it to a free spot.' : ` X ${widget.x}, Y ${widget.y}.`}`);
  }

  function removeSelected() {
    if (!selected) return;
    const previous = documentRef.current;
    const index = previous.widgets.findIndex((widget) => widget.id === selected.id);
    const next = removeWidget(previous, selected.id);
    const id = next.widgets[Math.min(index, next.widgets.length - 1)]?.id ?? null;
    change(next); setSelectedId(id); setUndoRemoval({ document: previous, selectedId: selected.id });
    setMessage(`Removed ${widgetLabel(selected)}.`);
    requestAnimationFrame(() => {
      if (id) [...window.document.querySelectorAll<HTMLButtonElement>('[data-widget-row]')].find((row) => row.dataset.widgetRow === id)?.focus();
      else addButton.current?.focus();
    });
  }

  function applyPreset(next: LayoutDocument) {
    const draft = { ...next, palette: documentRef.current.palette };
    delete draft.paletteMode;
    if (documentRef.current.paletteMode !== undefined) draft.paletteMode = documentRef.current.paletteMode;
    setDocumentGeneration((generation) => generation + 1);
    change(draft); setSelectedId(draft.widgets[0]?.id ?? null); setPendingImport(null); setLastExport(null);
    setError(''); setMessage(`Created ${draft.name}. ${panel.available ? 'Choose Save to panel when ready.' : 'Export JSON to keep this layout.'}`);
  }

  function choosePreset(preset: LayoutPreset) {
    presetsDialog.current?.close();
    if (dirtyRef.current) setPendingImport({ document: preset.document, preset: true });
    else applyPreset(preset.document);
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
    setUndoRemoval(null);
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
      <div className="header-actions"><SavedLayouts available={panel.available} busy={panel.saving || panel.openingSaved || panel.switching} presets={presets} getDocument={() => documentRef.current} onSwitch={switchPanelLayout} onError={setError} onMessage={setMessage} /><button onClick={() => presetsDialog.current?.showModal()}>Create layout</button><button onClick={() => layoutInput.current?.click()}>Open layout</button><button onClick={exportLayout} className={panel.available ? '' : 'primary-button'}>Export JSON <span aria-hidden="true">↗</span></button>{panel.available && <button className="primary-button" disabled={panel.saving || panel.openingSaved || panel.switching || !panel.revision} onClick={() => void saveToPanel()}>{panel.saving ? 'Saving…' : 'Save to panel'}</button>}</div>
      <input ref={layoutInput} type="file" accept=".json,application/json" hidden aria-label="Open layout file" onChange={(event) => void importFile(event, 'layout')} />
      <input ref={paletteInput} type="file" accept=".json,application/json" hidden aria-label="Import palette file" onChange={(event) => void importFile(event, 'palette')} />
    </header>
    <div className="document-bar"><div><span className="eyebrow">Layout document</span><h1 className="visually-hidden">{document.name}</h1><ContentField label="Layout name" value={document.name} onCommit={(value) => { if (!String(value).trim()) throw new Error('Enter a layout name.'); change((current) => ({ ...current, name: String(value) })); }} /></div><div className="document-indicators">{panel.available && <span className="panel-status" role="status">{panelState}</span>}<span className={`document-status${dirty ? ' dirty' : ''}`} data-testid="document-status">{dirty ? lastExport === serialized ? 'Export requested' : 'Unsaved changes' : 'No unsaved changes'}</span></div></div>
    {panel.available && !panel.revision && <p className="panel-note">Export your draft, then open the saved layout to enable Save to panel. You can reopen your exported draft afterwards.</p>}
    <div className="workspace">
      <aside className="widget-panel" aria-label="Widgets">
        <div className="panel-heading"><h2>Widgets</h2><span className="count-badge">{document.widgets.length}</span></div>
        <button ref={addButton} className="add-widget-button" onClick={() => catalogDialog.current?.showModal()}>Add widget</button><p className="panel-note">Select a card to edit it.</p>
        <div className="widget-list">{document.widgets.map((widget) => <button key={widget.id} className={`widget-row${selectedId === widget.id ? ' active' : ''}`}
          data-widget-row={widget.id} aria-pressed={selectedId === widget.id} onClick={() => setSelectedId(widget.id)}>
          <span className="widget-icon" aria-hidden="true">{{ metric: '▤', weather: '☀', clock: '◷', text: '¶', gauge: '◔', storage: '▣' }[widget.type]}</span>
          <span><strong>{widgetLabel(widget)}</strong><small>{widget.type}{widget.type === 'text' ? '' : ` · ${sourceLabels[widget.settings.source ?? 'sample']}`}</small></span><span className="widget-row-mark" aria-hidden="true">↗</span>
        </button>)}</div>
        {document.widgets.length === 0 && <p className="panel-note">This canvas is empty. Add a widget or create a layout from a preset.</p>}
        <div className="palette-section"><span className="eyebrow">Preview palette</span><h3>Caelestia</h3><div className="swatches" aria-label={`${document.palette.name} palette`}>
          {(['background', 'surface', 'primary', 'secondary', 'text'] as const).map((key) => <span key={key} title={`${key} ${document.palette[key]}`} style={{ background: document.palette[key] }} />)}
        </div><p className="panel-note">{displayPalette.name}<br />{document.paletteMode === 'live' ? 'Following the desktop scheme.' : 'Stored with this layout.'}</p>{panel.available && <label className="theme-choice"><input type="checkbox" checked={document.paletteMode === 'live'} onChange={(event) => change((current) => ({ ...current, paletteMode: event.target.checked ? 'live' : 'saved' }))} /> Follow desktop colours</label>}<button className="text-button" onClick={() => paletteInput.current?.click()}>Import scheme.json <span aria-hidden="true">↗</span></button></div>
        <div className="offline-note"><span className="status-dot" /><div><strong>{panel.available ? 'Panel connection' : 'Preview only'}</strong><p>{panel.available ? panel.status.error || (panelChangedElsewhere ? 'The panel switched outside this editor. Open saved layout to view it.' : 'Canvas uses sample data. Panel uses selected sources.') : 'Sample data. No panel connection.'}</p>{panel.available && <><button className="text-button" disabled={panel.saving || panel.openingSaved || panel.switching} onClick={() => void openPanelLayout()}>Open saved layout</button><button className="text-button" onClick={() => { setPanelImage(`/api/frame?t=${Date.now()}`); panelDialog.current?.showModal(); }}>View panel frame</button></>}</div></div>
      </aside>
      <CanvasPreview key={documentGeneration} document={document} selectedId={selectedId} onSelect={setSelectedId} onChange={change} getDocument={() => documentRef.current} bitmap={panel.preview} />
      <aside className="inspector-panel" aria-label="Inspector"><div className="panel-heading"><h2>Inspector</h2><span className="mono">px</span></div>
        {selected ? <div key={`${documentGeneration}:${selected.id}`}>
          <div className="selected-widget"><span className="eyebrow">{selected.type} card</span><h3>{widgetLabel(selected)}</h3><span className="mono widget-id">{selected.id}</span><div className="widget-actions"><button onClick={() => appendWidget()}>Duplicate</button><button className="remove-button" onClick={removeSelected}>Remove</button></div></div>
          <div className="inspector-section"><h4>Position & size</h4><div className="geometry-grid">
            {(Object.keys(geometryLabels) as (keyof Geometry)[]).map((field) => <GeometryField key={field} field={field} value={selected[field]}
              max={field === 'x' ? document.canvas.width - selected.width : field === 'y' ? document.canvas.height - selected.height : field === 'width' ? document.canvas.width - selected.x : document.canvas.height - selected.y}
              onCommit={(value) => change((current) => updateGeometry(current, selected.id, { [field]: value }))} />)}
          </div><p className="panel-note">Whole pixels only. Values stay inside the canvas.</p></div>
          {selected.type !== 'text' && <div className="inspector-section"><h4>Panel data</h4><label className="source-field">Source<select aria-label="Panel data source" value={selected.settings.source ?? 'sample'} onChange={(event) => setSource(event.target.value)}>{widgetSources(selected).map((source) => <option key={source} value={source}>{sourceLabels[source]}</option>)}</select></label><p className="panel-note">The canvas stays deterministic. Live values appear on the panel after saving.{selected.type === 'storage' && <><br />All mounted local filesystems, including /mnt. Shared mounts appear once. Enlarge the card to show more rows.</>}{selected.type === 'gauge' && <><br />Memory gauges use %. Network gauges use KB/s.</>}</p></div>}
          <ContentEditor widget={selected} onCommit={(patch) => change((current) => updateWidgetSettings(current, selected.id, patch))} />
          <div className="keyboard-note"><span className="eyebrow">Fine adjustments</span><p>Focus a card, then use the arrow keys.</p><div><kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd><span>1 px</span></div><p>Hold <kbd>Shift</kbd> for 10 px.</p></div>
        </div> : <p className="panel-note">Select a card on the canvas or in the widget list.</p>}
      </aside>
    </div>
    <footer className="app-footer"><span role="status" aria-live="polite">{message}{undoRemoval && <button className="undo-button" onClick={() => { change(undoRemoval.document); setSelectedId(undoRemoval.selectedId); setMessage('Restored removed widget.'); focusCard(undoRemoval.selectedId); }}>Undo</button>}</span><span className="mono">Layout v{document.version} · Sample data</span></footer>
    {(error || panel.previewError) && <div className="error-banner" role="alert"><span>{error || panel.previewError}</span><button aria-label="Dismiss import error" onClick={() => setError('')}>×</button></div>}
    <dialog ref={catalogDialog} className="catalog-dialog widget-library-dialog" aria-labelledby="catalog-title">
      <WidgetLibrary entries={widgetCatalog} groups={widgetGroups} onAdd={appendWidget} onClose={() => catalogDialog.current?.close()} />
    </dialog>
    <dialog ref={presetsDialog} className="catalog-dialog" aria-labelledby="presets-title">
      <div className="panel-heading"><h2 id="presets-title">Create layout from a preset</h2><button aria-label="Close layout presets" onClick={() => presetsDialog.current?.close()}>×</button></div>
      <p className="panel-note">A preset replaces the draft and keeps your palette. The panel keeps its current layout until you choose Save to panel.</p>
      {presetError ? <p className="panel-note" role="alert">{presetError}</p> : presets.length === 0 ? <p className="panel-note">No ready-made layouts available yet.</p> : <div className="preset-grid">{presets.map((preset) => <button key={preset.id} aria-label={`Create ${preset.name}`} onClick={() => choosePreset(preset)}><StaticLayout document={preset.document} /><strong>{preset.name}</strong><span>{preset.description}</span></button>)}</div>}
    </dialog>
    <dialog ref={panelDialog} className="panel-frame-dialog"><h2>Last accepted panel frame</h2><p>{panel.status.frameTime ? `Captured ${new Date(panel.status.frameTime * 1000).toLocaleTimeString()}.` : 'No captured frame yet.'} Captures update at most every 10 seconds. This shows the frame before the USB rotation.</p><img src={panelImage || undefined} alt="Last frame accepted by the panel" /><button onClick={() => panelDialog.current?.close()}>Close</button></dialog>
    <dialog ref={importDialog} className="import-dialog" aria-labelledby="import-title" onCancel={(event) => { event.preventDefault(); setPendingImport(null); }}>
      {pendingImport && <>
      <h2 id="import-title">Replace unsaved changes?</h2><p>{pendingImport.preset ? 'Creating' : 'Opening'} {pendingImport.document.name} replaces your current layout. Export your changes first if you want to keep them.</p>
      <div><button autoFocus onClick={() => setPendingImport(null)}>Keep editing</button><button className="primary-button" onClick={() => pendingImport.preset ? applyPreset(pendingImport.document) : load(pendingImport.document, pendingImport.panelRevision)}>{pendingImport.preset ? 'Create and discard changes' : 'Open and discard changes'}</button></div>
      </>}
    </dialog>
  </main>;
}
