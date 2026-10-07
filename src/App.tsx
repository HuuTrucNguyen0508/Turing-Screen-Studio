import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, KeyboardEvent, SetStateAction } from 'react';
import PreviewSources from './PreviewSources';
import CanvasPreview, { widgetLabel } from './CanvasPreview';
import usePanel from './usePanel';
import useEditor from './useEditor';
import useCustomWidgets from './useCustomWidgets';
import CustomWidgets from './CustomWidgets';
import DesignEditor from './DesignEditor';
import { updateWidgetDesign } from './domain/design';
import { placedTemplate } from './domain/widgetTemplates';
import useDraftRecovery from './useDraftRecovery';
import type { RecoveryEntry } from './domain/recovery';
import ContentEditor, { ContentField } from './ContentEditor';
import { StaticLayout } from './WidgetContent';
import WidgetLibrary from './WidgetLibrary';
import SavedLayouts from './SavedLayouts';
import HistoryDialog from './HistoryDialog';
import GameTimers from './GameTimers';
import CanvasSize from './CanvasSize';
import type { DraftTarget } from './domain/draft';
import { duplicateEntry, libraryTarget, parseLibrary } from './domain/library';
import type { Library, LibraryDraftTarget } from './domain/library';
import type { LayoutSelection } from './SavedLayouts';
import { addWidget, addWidgetTemplate, duplicateWidget, parseLayoutPresets, removeWidget, sourceLabels, updateWidgetSettings, widgetCatalog, widgetGroups, widgetSources } from './domain/widgets';
import type { LayoutPreset } from './domain/widgets';
import { moveSelection } from './domain/canvas';
import { parseCaelestiaPalette, parseLayout, serializeLayout, updateGeometry } from './domain/layout';
import type { Geometry, LayoutDocument, Palette, Widget } from './domain/layout';

const geometryLabels: Record<keyof Geometry, string> = { x: 'X position', y: 'Y position', width: 'Width', height: 'Height' };

function paletteStyle(palette: Palette): CSSProperties {
  return Object.fromEntries(Object.entries(palette).filter(([key]) => key !== 'name').map(([key, value]) => [`--${key}`, value])) as CSSProperties;
}

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
      }} /><span>px</span></div>
    {error && <span id={`error-${field}`} className="field-error">{error}</span>}
  </label>;
}

export default function App() {
  const editor = useEditor();
  const { document, baseline, selectedId, selectedIds } = editor.state;
  const setSelectedId = editor.select;
  const recovery = useDraftRecovery(editor.state);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [message, setMessage] = useState('Sample layout ready.');
  const [error, setError] = useState('');
  const [pendingImport, setPendingImport] = useState<{ document: LayoutDocument; panelRevision?: string; preset?: boolean; target?: DraftTarget } | null>(null);
  const [presets, setPresets] = useState<LayoutPreset[]>([]);
  const [presetError, setPresetError] = useState('');
  const [documentGeneration, setDocumentGeneration] = useState(0);
  const loadGeneration = useRef(0);
  const layoutInput = useRef<HTMLInputElement>(null);
  const paletteInput = useRef<HTMLInputElement>(null);
  const importDialog = useRef<HTMLDialogElement>(null);
  const importSequence = useRef(0);
  const panelDialog = useRef<HTMLDialogElement>(null);
  const catalogDialog = useRef<HTMLDialogElement>(null);
  const presetsDialog = useRef<HTMLDialogElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const recoveryDialog = useRef<HTMLDialogElement>(null);
  const conflictDialog = useRef<HTMLDialogElement>(null);
  const [comparison, setComparison] = useState<{ document: LayoutDocument; revision: string } | null>(null);
  const libraryConflictDialog = useRef<HTMLDialogElement>(null);
  const [libraryComparison, setLibraryComparison] = useState<Library | null>(null);
  const [librarySaving, setLibrarySaving] = useState(false);
  const libraryOperation = useRef(false);
  const [libraryError, setLibraryError] = useState('');
  const [panelImage, setPanelImage] = useState('');
  const serialized = serializeLayout(document);
  const dirty = serialized !== baseline;
  const dirtyRef = useRef(dirty);
  const documentRef = useRef(document);
  documentRef.current = document;
  dirtyRef.current = dirty || recovery.pending;
  const selected = document.widgets.find((widget) => widget.id === selectedId);
  const recoveryPending = useRef(recovery.pending);
  const deferredPanel = useRef<{ document: LayoutDocument; revision: string } | null>(null);
  const restoredOnStartup = useRef(false);
  recoveryPending.current = recovery.pending;
  const panel = usePanel(document, load, () => dirtyRef.current, (saved, revision) => {
    if (recoveryPending.current) deferredPanel.current = { document: saved, revision };
    else if (!restoredOnStartup.current) setPendingImport({ document: saved, panelRevision: revision });
  });
  const custom = useCustomWidgets(panel.available);
  const [customCandidate, setCustomCandidate] = useState<Widget | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [designElement, setDesignElement] = useState<string | null>(null);
  const [gameTimersOpen, setGameTimersOpen] = useState(false);
  const [canvasSizeOpen, setCanvasSizeOpen] = useState(false);
  const panelCompatible = document.canvas.width === 1280 && document.canvas.height === 800;
  const customEntries = custom.document.widgets.map((entry) => ({ id: `custom:${entry.id}`, name: entry.name, group: 'custom', family: entry.id, variant: 'Custom', description: custom.storeLabel, widget: placedTemplate(entry) }));
  const displayPalette = document.paletteMode === 'live' && panel.palette ? panel.palette : document.palette;
  const panelAccepted = Boolean(panel.revision && panel.status.appliedRevision === panel.revision && panel.status.requestedRevision === panel.revision);
  const panelChangedElsewhere = panel.status.requestedRevision && panel.status.requestedRevision !== editor.state.baseRevision;
  const panelState = !panel.status.runtimeRunning ? 'Runtime offline' : !panel.status.connected ? 'Reconnecting to panel' : panel.status.view === 'speedtest' ? 'Speedtest on panel' : panelChangedElsewhere ? 'Panel layout changed elsewhere' : panelAccepted ? 'Panel accepted frame' : 'Waiting for panel';

  async function switchPanelLayout(selection: LayoutSelection) {
    const result = await panel.switchLayout(selection);
    if (!result) return null;
    setError('');
    setMessage(`Switched panel to ${result.document.name}. Waiting for an accepted frame. Your editor draft is unchanged. Use Open panel dashboard to view the panel's dashboard.`);
    return result;
  }

  async function saveToPanel(expectedRevision?: string) {
    if (documentRef.current.canvas.width !== 1280 || documentRef.current.canvas.height !== 800) { setError('Panel saves need 1280 × 800. Export JSON to keep this draft.'); return false; }
    if (!expectedRevision && !editor.current.current.baseRevision) { await reviewPanelChanges(); return false; }
    const snapshot = parseLayout(serializeLayout(documentRef.current));
    const generation = loadGeneration.current;
    try {
      const revision = await panel.save(snapshot, expectedRevision ?? editor.current.current.baseRevision);
      if (revision && generation !== loadGeneration.current) { setMessage(`Saved ${snapshot.name} to the panel. The open draft was not changed.`); return true; }
      if (revision) { editor.current.current.target.kind === 'library' ? editor.revision(revision) : editor.saved(snapshot, revision, { kind: 'panel' }); setLastExport(null); setError(''); setMessage('Layout saved. Waiting for the panel to accept a frame.'); conflictDialog.current?.close(); setComparison(null); return true; }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save to panel.');
      if (generation === loadGeneration.current && comparison) { try { setComparison(await panel.openSaved()); } catch { /* Keep the displayed comparison and error. */ } }
    }
    return false;
  }

  async function openPanelLayout() {
    try { const next = await panel.openSaved(); if (dirtyRef.current) setPendingImport({ document: next.document, panelRevision: next.revision }); else load(next.document, next.revision); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not open the saved layout.'); }
  }

  async function reviewPanelChanges() {
    try { setComparison(await panel.openSaved()); conflictDialog.current?.showModal(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not read the panel dashboard.'); }
  }


  function openDraft(next: LayoutDocument, target: DraftTarget) {
    if (dirtyRef.current && serializeLayout(next) !== serializeLayout(editor.current.current.document)) setPendingImport({ document: next, target });
    else load(next, undefined, target);
  }

  function libraryUpdated(library: Library) {
    const target = editor.current.current.target;
    if (target.kind !== 'library') return;
    const entry = library.entries.find((item) => item.id === target.entryId);
    if (!entry) return;
    editor.target(serializeLayout(entry.document) === target.entryText ? libraryTarget(entry, library.revision) : { ...target, entryName: entry.name });
  }

  async function readLibrary(): Promise<Library> {
    const response = await fetch('/api/layouts', { signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Library could not be read.');
    return parseLibrary(data);
  }

  async function saveToLibrary(confirmed?: Library, asCopy = false) {
    if (documentRef.current.canvas.width !== 1280 || documentRef.current.canvas.height !== 800) { setLibraryError('Panel saves need 1280 × 800. Export JSON to keep this draft.'); return; }
    if (libraryOperation.current || editor.current.current.target.kind !== 'library') return;
    const target: LibraryDraftTarget = editor.current.current.target;
    const generation = loadGeneration.current;
    const snapshot = parseLayout(serializeLayout(editor.current.current.document));
    libraryOperation.current = true; setLibrarySaving(true); setLibraryError('');
    try {
      const library = confirmed ?? await readLibrary();
      if (generation !== loadGeneration.current) return;
      if (!confirmed && (library.revision !== target.libraryRevision || !library.entries.some((entry) => entry.id === target.entryId))) {
        setLibraryComparison(library); libraryConflictDialog.current?.showModal(); return;
      }
      const existing = library.entries.find((entry) => entry.id === target.entryId);
      if (!asCopy && !existing) throw new Error('This entry was removed. Save a new entry to keep this draft.');
      if (asCopy && library.entries.length >= 12) throw new Error('The library holds 12 entries. Export this draft or remove an entry first.');
      const copy = asCopy ? duplicateEntry({ id: target.entryId, name: target.entryName, document: snapshot }, library.entries, crypto.randomUUID()) : null;
      const entries = copy ? [...library.entries, copy] : library.entries.map((entry) => entry.id === target.entryId ? { ...entry, document: snapshot } : entry);
      const response = await fetch('/api/layouts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': library.revision }, body: JSON.stringify({ entries }), signal: AbortSignal.timeout(8000) });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && generation === loadGeneration.current) { const fresh = await readLibrary(); if (generation === loadGeneration.current) { setLibraryComparison(fresh); libraryConflictDialog.current?.showModal(); } }
        throw new Error(data.error ?? 'Library changed elsewhere. Your draft is intact.');
      }
      const saved = parseLibrary(data);
      const entry = saved.entries.find((item) => item.id === (copy?.id ?? target.entryId));
      if (!entry) throw new Error('The saved entry could not be verified. Your draft is intact.');
      if (generation !== loadGeneration.current) { setMessage(`Saved ${entry.name} to the library. The open draft was not changed.`); return; }
      if (copy && serializeLayout(editor.current.current.document) === serializeLayout(snapshot)) editor.change(entry.document);
      editor.saved(entry.document, editor.current.current.baseRevision, libraryTarget(entry, saved.revision));
      setMessage(`Saved ${entry.name} to the library. The panel keeps its current dashboard.`);
      setLibraryComparison(null); libraryConflictDialog.current?.close();
    } catch (failure) { setLibraryError(failure instanceof Error ? failure.message : 'Could not save to library.'); }
    finally { libraryOperation.current = false; setLibrarySaving(false); }
  }

  function download(text: string, name: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = window.document.createElement('a'); link.href = url; link.download = name; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function restoreDraft(entry: RecoveryEntry) {
    const record = recovery.restore(entry);
    if (!record) return;
    restoredOnStartup.current = true;
    editor.replace(record.document, { baseline: record.baseline, baseRevision: record.baseRevision, target: record.target });
    loadGeneration.current++; setDocumentGeneration((value) => value + 1); setPendingImport(null); setLastExport(null);
    setMessage(`Restored ${record.title} from ${new Date(record.time).toLocaleString()}.`);
  }

  function exportRecovery(entry: RecoveryEntry) {
    try {
      const raw = entry.raw ?? localStorage.getItem(entry.key);
      if (raw === null) throw new Error('This backup is no longer available.');
      download(raw, 'turzx-recovery.json');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not export the backup.'); }
  }

  function history(direction: 'undo' | 'redo') {
    if (editor.current.current.gesture) return;
    direction === 'undo' ? editor.undo() : editor.redo();
    setMessage(direction === 'undo' ? 'Undid the last edit.' : 'Redid the edit.');
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
    const template = presetId?.startsWith('custom:') ? custom.document.widgets.find((entry) => entry.id === presetId.slice(7)) : undefined;
    const next = template ? addWidgetTemplate(documentRef.current, placedTemplate(template), template.id) : presetId ? addWidget(documentRef.current, presetId) : duplicateWidget(documentRef.current, selectedId!);
    const widget = next.widgets[next.widgets.length - 1];
    change(next, widget.id); catalogDialog.current?.close(); focusCard(widget.id);
    const overlaps = next.widgets.slice(0, -1).some((other) => widget.x < other.x + other.width && widget.x + widget.width > other.x && widget.y < other.y + other.height && widget.y + widget.height > other.y);
    setMessage(`${presetId ? 'Added' : 'Duplicated'} ${widgetLabel(widget)}.${overlaps ? ' It overlaps another card; drag it to a free spot.' : ` X ${widget.x}, Y ${widget.y}.`}`);
  }

  function removeSelected() {
    if (!selected) return;
    const previous = documentRef.current;
    const index = previous.widgets.findIndex((widget) => widget.id === selected.id);
    const next = removeWidget(previous, selected.id);
    const id = next.widgets[Math.min(index, next.widgets.length - 1)]?.id ?? null;
    change(next, id);
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
    loadGeneration.current++; setDocumentGeneration((generation) => generation + 1);
    change(draft, draft.widgets[0]?.id ?? null); setPendingImport(null); setLastExport(null);
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
    const dialog = recoveryDialog.current!;
    if (recovery.pending && !dialog.open) dialog.showModal();
    if (!recovery.pending && dialog.open) dialog.close();
  }, [recovery.pending]);

  useEffect(() => {
    if (recovery.pending || !deferredPanel.current) return;
    const saved = deferredPanel.current; deferredPanel.current = null;
    if (restoredOnStartup.current) return;
    if (serializeLayout(editor.current.current.document) !== editor.current.current.baseline) setPendingImport({ document: saved.document, panelRevision: saved.revision });
    else load(saved.document, saved.revision);
  }, [recovery.pending]);

  useEffect(() => {
    const handle = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable]') || event.isComposing || event.altKey
        || !(event.ctrlKey || event.metaKey) || !['z', 'y', 'a'].includes(event.key.toLowerCase())
        || window.document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (event.key.toLowerCase() === 'a') { if (!editor.current.current.gesture) editor.selectAll(); }
      else history(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  });

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function change(update: SetStateAction<LayoutDocument>, selection?: string | null) {
    editor.change(update, selection);
    documentRef.current = editor.current.current.document;
  }

  function load(next: LayoutDocument, panelRevision?: string, target?: DraftTarget) {
    if (panelRevision && (!target || target.kind === 'panel')) panel.adoptSaved(panelRevision);
    loadGeneration.current++; setDocumentGeneration((generation) => generation + 1);
    editor.replace(next, { baseRevision: panelRevision ?? panel.revision ?? editor.current.current.baseRevision, target: target ?? { kind: panelRevision ? 'panel' : 'local' } });
    documentRef.current = next; setLastExport(null); setPendingImport(null);
    setError(''); setMessage(`Opened ${next.name}. Edit history starts here.`);
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
    change((current) => moveSelection(current, editor.current.current.selectedIds, step[0] * multiplier, step[1] * multiplier));
  }

  return <main className="studio" style={paletteStyle(displayPalette)} onKeyDown={nudge}>
    <header className="app-header">
      <a className="brand" href="#" onClick={(event) => event.preventDefault()} aria-label="TURZX Studio"><span className="brand-symbol" aria-hidden="true">T</span><span>TURZX<span className="brand-light"> Studio</span></span></a>
      <div className="mode-badge"><span className="status-dot" />{panel.available ? 'Panel editor' : 'Offline editor'}</div>
      <div className="header-actions"><SavedLayouts draftCompatible={panelCompatible} onEdit={(next, target) => openDraft(next, target)} onLibraryUpdated={libraryUpdated} available={panel.available} busy={panel.saving || panel.openingSaved || panel.switching} presets={presets} getDocument={() => documentRef.current} onSwitch={switchPanelLayout} onError={setError} onMessage={setMessage} /><HistoryDialog available={panel.available} onOpen={openDraft} /><button onClick={() => setGameTimersOpen(true)}>Game timers</button><button onClick={() => presetsDialog.current?.showModal()}>Create layout</button><button onClick={() => layoutInput.current?.click()}>Open layout</button><button onClick={exportLayout} className={panel.available ? '' : 'primary-button'}>Export JSON <span aria-hidden="true">↗</span></button>{panel.available && editor.state.target.kind === 'library' && <button aria-describedby={!panelCompatible ? 'panel-size-note' : undefined} title={!panelCompatible ? 'Panel saves need 1280 × 800. Export JSON to keep this draft.' : undefined} disabled={!panelCompatible || librarySaving || serialized === editor.state.target.entryText} onClick={() => void saveToLibrary()}>Save to library</button>}{panel.available && <button className="primary-button" aria-describedby={!panelCompatible ? 'panel-size-note' : undefined} title={!panelCompatible ? 'Panel saves need 1280 × 800. Export JSON to keep this draft.' : undefined} disabled={!panelCompatible || panel.saving || panel.openingSaved || panel.switching} onClick={() => void saveToPanel()}>{panel.saving ? 'Saving…' : 'Save to panel'}</button>}</div>
      <input ref={layoutInput} type="file" accept=".json,application/json" hidden aria-label="Open layout file" onChange={(event) => void importFile(event, 'layout')} />
      <input ref={paletteInput} type="file" accept=".json,application/json" hidden aria-label="Import palette file" onChange={(event) => void importFile(event, 'palette')} />
    </header>
    {panel.available && !panelCompatible && <p id="panel-size-note" className="panel-note">Panel saves need 1280 × 800. Export JSON to keep this draft.</p>}
    <div className="document-bar"><div><span className="eyebrow">{editor.state.target.kind === 'library' ? `Library draft · ${editor.state.target.entryName}` : editor.state.target.kind === 'archive' ? 'History draft' : 'Layout document'}</span><h1 className="visually-hidden">{document.name}</h1><ContentField label="Layout name" value={document.name} onCommit={(value) => { if (!String(value).trim()) throw new Error('Enter a layout name.'); change((current) => ({ ...current, name: String(value) })); }} /></div><div className="document-indicators">{panel.available && <span className="panel-status" role="status">{panelState}</span>}<div className="edit-history" aria-label="Edit history"><button aria-label="Undo" aria-keyshortcuts="Control+Z Meta+Z" title="Undo (Ctrl+Z)" disabled={!editor.state.past.length || Boolean(editor.state.gesture)} onClick={() => history('undo')}>↶ Undo</button><button aria-label="Redo" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" title="Redo (Ctrl+Shift+Z)" disabled={!editor.state.future.length || Boolean(editor.state.gesture)} onClick={() => history('redo')}>↷ Redo</button></div><span className={`document-status${dirty ? ' dirty' : ''}`} data-testid="document-status">{dirty ? lastExport === serialized ? 'Export requested' : 'Unsaved changes' : 'No unsaved changes'}</span></div></div>
    {panel.available && panelChangedElsewhere && <div className="change-notice"><span>The panel dashboard changed. Your draft is intact.</span><button disabled={panel.saving || panel.openingSaved || panel.switching} onClick={() => void reviewPanelChanges()}>Review panel changes</button></div>}
    <div className="workspace">
      <aside className="widget-panel" aria-label="Widgets">
        <div className="panel-heading"><h2>Widgets</h2><span className="count-badge">{document.widgets.length}</span></div>
        <button ref={addButton} className="add-widget-button" onClick={() => catalogDialog.current?.showModal()}>Add widget</button><div className="selection-actions"><button disabled={Boolean(editor.state.gesture) || !document.widgets.length} onClick={editor.selectAll} aria-keyshortcuts="Control+A Meta+A">Select all</button><span>{selectedIds.length} selected</span></div><p className="panel-note">Shift-click adds cards. Front layer first.</p>
        <div className="widget-list" aria-label="Layers, front to back">{[...document.widgets].reverse().map((widget) => <button key={widget.id} className={`widget-row${selectedIds.includes(widget.id) ? ' active' : ''}`}
          data-widget-row={widget.id} aria-pressed={selectedIds.includes(widget.id)} onClick={(event) => setSelectedId(widget.id, event.shiftKey)}>
          <span className="widget-icon" aria-hidden="true">{{ metric: '▤', weather: '☀', clock: '◷', text: '¶', gauge: '◔', storage: '▣' }[widget.type]}</span>
          <span><strong>{widgetLabel(widget)}</strong><small>{widget.type}{widget.type === 'text' ? '' : ` · ${sourceLabels[widget.settings.source ?? 'sample']}`}</small></span><span className="widget-row-mark" title="Paint layer, higher is in front">{document.widgets.findIndex((entry) => entry.id === widget.id) + 1}</span>
        </button>)}</div>
        {document.widgets.length === 0 && <p className="panel-note">This canvas is empty. Add a widget or create a layout from a preset.</p>}
        <div className="palette-section"><span className="eyebrow">Preview palette</span><h3>Caelestia</h3><div className="swatches" aria-label={`${document.palette.name} palette`}>
          {(['background', 'surface', 'primary', 'secondary', 'text'] as const).map((key) => <span key={key} title={`${key} ${document.palette[key]}`} style={{ background: document.palette[key] }} />)}
        </div><p className="panel-note">{displayPalette.name}<br />{document.paletteMode === 'live' ? 'Following the desktop scheme.' : 'Stored with this layout.'}</p>{panel.available && <label className="theme-choice"><input type="checkbox" checked={document.paletteMode === 'live'} onChange={(event) => change((current) => ({ ...current, paletteMode: event.target.checked ? 'live' : 'saved' }))} /> Follow desktop colours</label>}<button className="text-button" onClick={() => paletteInput.current?.click()}>Import scheme.json <span aria-hidden="true">↗</span></button></div>
        <div className="offline-note"><span className="status-dot" /><div><strong>{panel.available ? 'Panel connection' : 'Preview only'}</strong><p>{panel.available ? panel.status.error || (panelChangedElsewhere ? 'The panel switched outside this editor. Open panel dashboard to view it.' : 'Preview uses the chosen data mode. Save to panel applies this draft.') : panel.connectionError || 'Sample data. No panel connection.'}</p>{panel.available && <><button className="text-button" disabled={panel.saving || panel.openingSaved || panel.switching} onClick={() => void openPanelLayout()}>Open panel dashboard</button><button className="text-button" onClick={() => { setPanelImage(`/api/frame?t=${Date.now()}`); panelDialog.current?.showModal(); }}>View panel frame</button></>}</div></div>
      </aside>
      <CanvasPreview onResizeCanvas={() => setCanvasSizeOpen(true)} key={documentGeneration} document={document} selectedId={selectedId} selectedIds={selectedIds} getSelection={() => editor.current.current.selectedIds} onSelect={setSelectedId} onChange={change} getDocument={() => documentRef.current} onGestureStart={editor.begin} onGestureEnd={editor.finish} previewControls={<PreviewSources available={panel.available} mode={panel.previewMode} onMode={panel.setPreviewMode} />} designElement={designElement} bitmap={editor.state.gesture ? null : panel.preview} onPreviewRetry={panel.previewError ? panel.retryPreview : undefined} previewNotice={panel.available ? panel.previewError || (panel.previewPending ? panel.previewMode === 'live' ? 'Rendering live preview…' : 'Rendering sample preview…' : panel.previewMode === 'live' ? 'Panel renderer · Live readings' : 'Panel renderer · Sample values') : 'Browser renderer · Sample values'} />
      <aside className="inspector-panel" aria-label="Inspector"><div className="panel-heading"><h2>Inspector</h2><span className="mono">px</span></div>
        {selected ? <div key={`${documentGeneration}:${selected.id}`}>
          <div className="selected-widget"><span className="eyebrow">{selected.type} card</span><h3>{widgetLabel(selected)}</h3><span className="mono widget-id">{selected.id}</span><div className="widget-actions"><button onClick={() => appendWidget()}>Duplicate</button><button className="remove-button" onClick={removeSelected}>Remove</button></div></div>
          <div className="inspector-section"><h4>Position & size</h4>{selectedIds.length > 1 && <p className="panel-note">{selectedIds.length} cards selected. Use Same width, Same height or Same size above the canvas to match {widgetLabel(selected)}. Position fields edit this card.</p>}<div className="geometry-grid">
            {(Object.keys(geometryLabels) as (keyof Geometry)[]).map((field) => <GeometryField key={field} field={field} value={selected[field]} disabled={selectedIds.length > 1 && (field === 'width' || field === 'height')}
              max={field === 'x' ? document.canvas.width - selected.width : field === 'y' ? document.canvas.height - selected.height : field === 'width' ? document.canvas.width - selected.x : document.canvas.height - selected.y}
              onCommit={(value) => change((current) => updateGeometry(current, selected.id, { [field]: value }))} />)}
          </div><p className="panel-note">Whole pixels only. Values stay inside the canvas.</p></div>
          {selected.type !== 'text' && <div className="inspector-section"><h4>Panel data</h4><label className="source-field">Source<select aria-label="Panel data source" value={selected.settings.source ?? 'sample'} onChange={(event) => setSource(event.target.value)}>{widgetSources(selected).map((source) => <option key={source} value={source}>{sourceLabels[source]}</option>)}</select></label><p className="panel-note">Choose Sample or Live above the canvas to preview this source. Save to panel applies the layout.{selected.type === 'storage' && <><br />Physical drives combine mounted partition usage against the drive's full capacity. The partitions view can show selected mount paths. Shared filesystems are counted once.</>}{selected.type === 'gauge' && <><br />Memory gauges use %. Network gauges use KB/s.</>}</p></div>}
          <button disabled={custom.loading || custom.working} onClick={() => setCustomCandidate(parseLayout(serializeLayout(editor.current.current.document)).widgets.find((widget) => widget.id === selected.id)!)}>Save as custom widget…</button>
          {selected.type === 'metric' && selected.settings.source === 'game-resources' && <button onClick={() => setGameTimersOpen(true)}>Set game timers</button>}
          <ContentEditor widget={selected} onCommit={(patch) => change((current) => updateWidgetSettings(current, selected.id, patch))} />
          <DesignEditor widget={selected} onInspect={setDesignElement} onCommit={(patch) => change((current) => updateWidgetDesign(current, selected.id, patch))} />
          <div className="keyboard-note"><span className="eyebrow">Fine adjustments</span><p>Focus a card, then use the arrow keys.</p><div><kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd><span>1 px</span></div><p>Hold <kbd>Shift</kbd> for 10 px.</p></div>
        </div> : <p className="panel-note">Select a card on the canvas or in the widget list.</p>}
      </aside>
    </div>
    <footer className="app-footer"><span role="status" aria-live="polite">{message}</span><div className="recovery-status"><span title={recovery.time ? `Backed up ${new Date(recovery.time).toLocaleTimeString()}` : undefined}>{recovery.backedUp ? 'Draft backed up' : recovery.error && dirty ? 'Draft not backed up' : dirty ? 'Backing up draft…' : panel.previewMode === 'live' && panel.preview && !panel.previewError ? 'Layout v1 · Live readings' : 'Layout v1 · Sample data'}</span><button className="text-button" onClick={recovery.refresh}>Recover drafts</button></div></footer>
    {recovery.error && !recovery.pending && <p className="recovery-error" role="alert">{recovery.error}</p>}
    {error && !comparison && !libraryComparison && !recovery.pending && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss import error" onClick={() => setError('')}>×</button></div>}
    {canvasSizeOpen && <CanvasSize document={document} available={panel.available} onClose={() => setCanvasSizeOpen(false)} onResize={next => {
      change(next); setDocumentGeneration(generation => generation + 1); setError('');
      setMessage(`Resized canvas to ${next.canvas.width} × ${next.canvas.height}. Undo restores the previous size and cards.`);
    }} />}
    <GameTimers open={gameTimersOpen} available={panel.available} onClose={() => setGameTimersOpen(false)} onChanged={panel.retryPreview} />
    <dialog ref={recoveryDialog} className="catalog-dialog recovery-dialog" aria-labelledby="recovery-title" onCancel={(event) => { event.preventDefault(); recovery.close(); }}>
      <div className="panel-heading"><h2 id="recovery-title">Recover a draft</h2><button aria-label="Close draft recovery" onClick={recovery.close}>×</button></div>
      <p>Restore an unfinished draft. The panel keeps its current dashboard.</p>
      {(recovery.error || error) && <p className="recovery-error" role="alert">{recovery.error || error}</p>}
      {recovery.entries.length === 0 && <p>No unfinished drafts were found.</p>}
      <div className="recovery-list">{recovery.entries.map((entry) => <article key={entry.key}>
        {entry.status === 'valid' && <StaticLayout document={entry.record.document} />}
        <div><h3>{entry.status === 'valid' ? entry.record.title : 'Unreadable draft'}</h3><p>{entry.status === 'valid' ? `${new Date(entry.record.time).toLocaleString()} · ${entry.record.document.widgets.length} widgets` : entry.error}</p>
          {entry.status === 'valid' && <><p className="panel-note">{entry.record.source}{recovery.activeElsewhere(entry) ? ' · Open in another tab; restore makes a copy.' : ''}</p><button onClick={() => restoreDraft(entry)}>Restore draft</button></>}
          <button onClick={() => exportRecovery(entry)}>Export backup</button>
          <button disabled={recovery.activeElsewhere(entry)} onClick={() => recovery.discard(entry)}>Discard draft</button>
        </div>
      </article>)}</div>
      <button onClick={recovery.close}>Keep editing</button>
    </dialog>
    <dialog ref={conflictDialog} className="catalog-dialog comparison-dialog" aria-labelledby="comparison-title" onCancel={() => setComparison(null)}>
      <div className="panel-heading"><h2 id="comparison-title">Panel changed</h2><button aria-label="Close comparison" onClick={() => { conflictDialog.current?.close(); setComparison(null); }}>×</button></div>
      {error && <p className="recovery-error" role="alert">{error}</p>}
      {comparison && <><p>The panel now shows {comparison.document.name}. Your draft is {document.name}.</p><div className="comparison-grid"><div><h3>Your draft</h3><StaticLayout document={document} /></div><div><h3>Panel now</h3><StaticLayout document={comparison.document} /></div></div><p>Replacing the panel archives its current dashboard first. A newer change will reject this save.</p><div className="comparison-actions"><button onClick={exportLayout}>Export my draft</button><button disabled={panel.saving || panel.openingSaved} onClick={() => void reviewPanelChanges()}>Reload comparison</button><button disabled={panel.saving} onClick={() => void saveToPanel(comparison.revision)}>Replace panel with draft</button><button autoFocus onClick={() => { conflictDialog.current?.close(); setComparison(null); }}>Keep editing</button></div></>}
    </dialog>

    <dialog ref={libraryConflictDialog} className="catalog-dialog comparison-dialog" aria-labelledby="library-comparison-title" onCancel={() => setLibraryComparison(null)}>
      <div className="panel-heading"><h2 id="library-comparison-title">Library changed</h2><button aria-label="Close library comparison" onClick={() => { libraryConflictDialog.current?.close(); setLibraryComparison(null); }}>×</button></div>
      {libraryError && <p role="alert" className="recovery-error">{libraryError}</p>}
      {libraryComparison && <><p>Your draft is intact. Review the saved entry before replacing it.</p><div className="comparison-grid"><div><h3>Your draft</h3><StaticLayout document={document} /></div><div><h3>Library now</h3>{libraryComparison.entries.find((entry) => editor.state.target.kind === 'library' && entry.id === editor.state.target.entryId) ? <StaticLayout document={libraryComparison.entries.find((entry) => editor.state.target.kind === 'library' && entry.id === editor.state.target.entryId)!.document} /> : <p>This entry was removed.</p>}</div></div><div className="comparison-actions"><button onClick={exportLayout}>Export my draft</button><button disabled={librarySaving} onClick={() => void readLibrary().then(setLibraryComparison).catch((failure) => setLibraryError(String(failure)))}>Reload comparison</button><button disabled={librarySaving || !libraryComparison.entries.some((entry) => editor.state.target.kind === 'library' && entry.id === editor.state.target.entryId)} onClick={() => void saveToLibrary(libraryComparison)}>Replace library entry with draft</button><button disabled={librarySaving || libraryComparison.entries.length >= 12} onClick={() => void saveToLibrary(libraryComparison, true)}>Save as new entry</button><button autoFocus onClick={() => { libraryConflictDialog.current?.close(); setLibraryComparison(null); }}>Keep editing</button></div></>}
    </dialog>
    {libraryError && !libraryComparison && <p role="alert" className="recovery-error">{libraryError}</p>}
    <dialog ref={catalogDialog} className="catalog-dialog widget-library-dialog" aria-labelledby="catalog-title">
      <button className="text-button" onClick={() => setCustomOpen(true)}>Manage custom widgets</button><WidgetLibrary entries={[...customEntries, ...widgetCatalog]} groups={[{ id: 'custom', name: 'Custom widgets' }, ...widgetGroups]} onAdd={appendWidget} onClose={() => catalogDialog.current?.close()} />
    </dialog>
    <CustomWidgets store={custom} candidate={customCandidate} onCloseCandidate={() => setCustomCandidate(null)} open={customOpen} onClose={() => setCustomOpen(false)} getWidget={() => editor.current.current.document.widgets.find((widget) => widget.id === editor.current.current.selectedId)} onAdd={(id) => appendWidget(`custom:${id}`)} />
    <dialog ref={presetsDialog} className="catalog-dialog" aria-labelledby="presets-title">
      <div className="panel-heading"><h2 id="presets-title">Create layout from a preset</h2><button aria-label="Close layout presets" onClick={() => presetsDialog.current?.close()}>×</button></div>
      <p className="panel-note">A preset replaces the draft and keeps your palette. The panel keeps its current layout until you choose Save to panel.</p>
      {presetError ? <p className="panel-note" role="alert">{presetError}</p> : presets.length === 0 ? <p className="panel-note">No ready-made layouts available yet.</p> : <div className="preset-grid">{presets.map((preset) => <button key={preset.id} aria-label={`Create ${preset.name}`} onClick={() => choosePreset(preset)}><StaticLayout document={preset.document} /><strong>{preset.name}</strong><span>{preset.description}</span></button>)}</div>}
    </dialog>
    <dialog ref={panelDialog} className="panel-frame-dialog"><h2>Last accepted panel frame</h2><p>{panel.status.frameTime ? `Captured ${new Date(panel.status.frameTime * 1000).toLocaleTimeString()}.` : 'No captured frame yet.'} Captures update at most every 10 seconds. This shows the frame before the USB rotation.</p><img src={panelImage || undefined} alt="Last frame accepted by the panel" /><button onClick={() => panelDialog.current?.close()}>Close</button></dialog>
    <dialog ref={importDialog} className="import-dialog" aria-labelledby="import-title" onCancel={(event) => { event.preventDefault(); setPendingImport(null); }}>
      {pendingImport && <>
      <h2 id="import-title">Replace unsaved changes?</h2><p>{pendingImport.preset ? 'Creating' : 'Opening'} {pendingImport.document.name} replaces your current layout. Export your changes first if you want to keep them.</p>
      <div><button autoFocus onClick={() => setPendingImport(null)}>Keep editing</button><button className="primary-button" onClick={() => pendingImport.preset ? applyPreset(pendingImport.document) : load(pendingImport.document, pendingImport.panelRevision, pendingImport.target)}>{pendingImport.preset ? 'Create and discard changes' : 'Open and discard changes'}</button></div>
      </>}
    </dialog>
  </main>;
}
