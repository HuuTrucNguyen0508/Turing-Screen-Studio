import { useEffect, useRef, useState } from 'react';
import type { LayoutDocument } from './domain/layout';
import { parseLayout, serializeLayout } from './domain/layout';
import type { LayoutPreset } from './domain/widgets';
import { duplicateEntry, libraryTarget, parseLibrary } from './domain/library';
import type { Entry, Library, LibraryDraftTarget } from './domain/library';
import { StaticLayout } from './WidgetContent';
import './saved-layouts.css';

export type LayoutSelection = { direction: 'next' | 'previous' } | { id: string } | { slot: number };
export type { Entry, Library, LibraryDraftTarget } from './domain/library';
export { parseLibrary } from './domain/library';
type Confirmation = { kind: 'replace'; entry: Entry; document: LayoutDocument }
  | { kind: 'remove'; entry: Entry } | { kind: 'rename'; entry: Entry };

export default function SavedLayouts({ available, busy, draftCompatible = true, presets, getDocument, onSwitch, onError, onMessage, onEdit, onTargetUpdated, onLibraryUpdated }: {
  draftCompatible?: boolean; available: boolean; busy: boolean; presets: LayoutPreset[]; getDocument: () => LayoutDocument;
  onSwitch: (selection: LayoutSelection) => Promise<{ activeId: string } | null>;
  onError: (message: string) => void; onMessage: (message: string) => void;
  onEdit?: (document: LayoutDocument, target: LibraryDraftTarget) => void;
  onLibraryUpdated?: (library: Library) => void;
  onTargetUpdated?: (target: LibraryDraftTarget) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [working, setWorking] = useState(false);
  const operation = useRef(false);
  const [error, setError] = useState('');
  const [presetId, setPresetId] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [rename, setRename] = useState('');
  const callbacks = useRef({ onSwitch, onError, busy });
  callbacks.current = { onSwitch, onError, busy };

  useEffect(() => {
    if (confirmation) confirmationDialog.current?.showModal();
    else confirmationDialog.current?.close();
  }, [confirmation]);

  async function refresh() {
    const response = await fetch('/api/layouts', { signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Library is unavailable.');
    const next = parseLibrary(data);
    setLibrary(next);
    return next;
  }

  async function show() {
    if (!dialog.current?.open) dialog.current?.showModal();
    setError('');
    if (operation.current) return;
    operation.current = true; setWorking(true);
    try { await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Library is unavailable.'); }
    finally { operation.current = false; setWorking(false); }
  }

  async function update(entries: Entry[]): Promise<Library | null> {
    if (operation.current || !library) return null;
    operation.current = true; setWorking(true); setError('');
    try {
      const response = await fetch('/api/layouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': library.revision },
        body: JSON.stringify({ entries }), signal: AbortSignal.timeout(8000),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) throw new Error('Library changed elsewhere. Refresh the list before trying again.');
        throw new Error(data.error ?? 'Could not save the library.');
      }
      const next = parseLibrary(data);
      setLibrary(next); onLibraryUpdated?.(next);
      onMessage('Saved to library. The panel keeps its current dashboard.');
      return next;
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the library.'); return null; }
    finally { operation.current = false; setWorking(false); }
  }

  async function switchTo(selection: LayoutSelection) {
    if (operation.current || callbacks.current.busy) return;
    operation.current = true; setWorking(true); setError('');
    try {
      if (!library) await refresh();
      const result = await callbacks.current.onSwitch(selection);
      if (result) setLibrary((current) => current ? { ...current, activeId: result.activeId } : current);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Could not switch the panel layout.';
      setError(message); callbacks.current.onError(message);
    } finally { operation.current = false; setWorking(false); }
  }

  const shortcut = useRef(switchTo);
  shortcut.current = switchTo;
  useEffect(() => {
    if (!available) return;
    const handle = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
        || !['F9', 'F10', 'F11', 'F12'].includes(event.key) || event.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) void shortcut.current({ slot: Number(event.key.slice(1)) - 8 });
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [available]);

  function edit(entry: Entry, next: Library) {
    dialog.current?.close();
    onEdit?.(parseLayout(serializeLayout(entry.document)), libraryTarget(entry, next.revision));
  }

  function addDraft() {
    if (!library || !draftCompatible) return;
    const snapshot = parseLayout(serializeLayout(getDocument()));
    void update([...library.entries, { id: `layout-${crypto.randomUUID()}`, name: snapshot.name, document: snapshot }]);
  }

  function addPreset() {
    const preset = presets.find((entry) => entry.id === presetId);
    if (!preset || !library) return;
    const current = getDocument();
    const snapshot = { ...preset.document, palette: current.palette, paletteMode: current.paletteMode ?? 'saved' };
    void update([...library.entries, { id: `layout-${crypto.randomUUID()}`, name: preset.name, document: snapshot }]);
  }

  function duplicate(entry: Entry, index: number) {
    if (!library || library.entries.length >= 12) return;
    const entries = [...library.entries];
    entries.splice(index + 1, 0, duplicateEntry(entry, entries, `layout-${crypto.randomUUID()}`));
    void update(entries);
  }

  function reorder(index: number, offset: number) {
    if (!library) return;
    const entries = [...library.entries];
    [entries[index], entries[index + offset]] = [entries[index + offset], entries[index]];
    void update(entries);
  }

  function confirm(action: Confirmation) {
    if (action.kind === 'replace' && !draftCompatible) return;
    setError(''); setRename(action.entry.name); setConfirmation(action);
  }

  async function commitConfirmation() {
    if (!confirmation || !library || (confirmation.kind === 'replace' && !draftCompatible)) return;
    const action = confirmation;
    const entries = action.kind === 'remove' ? library.entries.filter((saved) => saved.id !== action.entry.id)
      : library.entries.map((saved) => saved.id !== action.entry.id ? saved
        : action.kind === 'rename' ? { ...saved, name: rename.trim() }
        : { ...saved, name: action.document.name, document: action.document });
    const next = await update(entries);
    if (!next) return;
    setConfirmation(null);
    if (action.kind === 'replace') {
      const entry = next.entries.find((saved) => saved.id === action.entry.id);
      if (entry) edit(entry, next);
    } else if (action.kind === 'rename') {
      const entry = next.entries.find((saved) => saved.id === action.entry.id);
      if (entry) onTargetUpdated?.(libraryTarget(entry, next.revision));
    }
  }

  const disabled = working || busy;
  const full = (library?.entries.length ?? 0) >= 12;
  const removedIndex = confirmation?.kind === 'remove'
    ? library?.entries.findIndex((entry) => entry.id === confirmation.entry.id) ?? -1 : -1;
  const shifted = library?.entries.slice(removedIndex + 1).filter((_, index) => removedIndex + index < 4) ?? [];
  const confirmationTitle = confirmation?.kind === 'rename' ? 'Rename library entry'
    : confirmation?.kind === 'remove' ? 'Remove from library' : 'Replace with draft';
  return <>
    {available && <button onClick={() => void show()}>Library</button>}
    <dialog ref={dialog} className="catalog-dialog saved-layouts-dialog" aria-labelledby="saved-layouts-title">
      <div className="panel-heading"><h2 id="saved-layouts-title">Library</h2><button aria-label="Close library" onClick={() => dialog.current?.close()}>×</button></div>
      <p className="saved-layouts-lede">Edit a saved layout as a draft, or show it on the panel. Saving the library keeps the panel's current dashboard.</p>
      <div className="rotation-controls"><button disabled={disabled || !library?.entries.length} onClick={() => void switchTo({ direction: 'previous' })}>Previous layout</button><button disabled={disabled || !library?.entries.length} onClick={() => void switchTo({ direction: 'next' })}>Next layout</button><span><kbd>Ctrl</kbd> + <kbd>F9</kbd> / <kbd>F10</kbd> / <kbd>F11</kbd> / <kbd>F12</kbd></span></div>
      {error && !confirmation && <p className="saved-layouts-error" role="alert">{error}</p>}
      <div className="rotation-add"><button disabled={!draftCompatible || disabled || !library || full} onClick={addDraft}>Add current draft</button><label>Ready-made layout<select aria-label="Ready-made layout to save" value={presetId} disabled={disabled} onChange={(event) => setPresetId(event.target.value)}><option value="">Choose a preset</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label><button disabled={disabled || !library || !presetId || full} onClick={addPreset}>Add preset</button><button disabled={disabled} onClick={() => void show()}>Refresh list</button></div>
      {!draftCompatible && <p className="panel-note">Panel saves need 1280 × 800. Export JSON to keep this draft.</p>}
      {full && <p className="panel-note">Library holds 12 layouts. Remove an entry before adding another.</p>}
      {library ? <ol className="saved-layout-list">{library.entries.map((entry, index) => <li key={entry.id} className={entry.id === library.activeId ? 'active-layout' : ''}>
        <span className="layout-order" aria-hidden="true">{index + 1}</span><StaticLayout document={entry.document} />
        <div className="saved-layout-info"><h3>{entry.name}</h3><p>{index < 4 && <kbd>Ctrl + F{index + 9}</kbd>}<span className="library-widget-count">{entry.document.widgets.length} widgets</span>{entry.id === library.activeId && <span className="on-panel">On panel</span>}</p><div className="saved-layout-actions">
          <button disabled={disabled} onClick={() => void switchTo({ id: entry.id })}>Show on panel</button>
          <button className="primary-button" disabled={disabled || !onEdit} onClick={() => edit(entry, library)}>Edit as draft</button>
          <button disabled={disabled || full} title={full ? 'Library holds 12 layouts.' : undefined} onClick={() => duplicate(entry, index)}>Duplicate</button>
          <button disabled={disabled} onClick={() => confirm({ kind: 'rename', entry })}>Rename</button>
          <button disabled={!draftCompatible || disabled} onClick={() => confirm({ kind: 'replace', entry, document: parseLayout(serializeLayout(getDocument())) })}>Replace with draft…</button>
          <button disabled={disabled} aria-label={`Remove ${entry.name} from library`} onClick={() => confirm({ kind: 'remove', entry })}>Remove…</button>
        </div></div>
        <div className="layout-order-controls"><button disabled={disabled || index === 0} aria-label={`Move ${entry.name} earlier`} onClick={() => reorder(index, -1)}>↑</button><button disabled={disabled || index === library.entries.length - 1} aria-label={`Move ${entry.name} later`} onClick={() => reorder(index, 1)}>↓</button></div>
      </li>)}</ol> : <p className="panel-note">{working ? 'Loading library…' : 'Refresh the list to load the library.'}</p>}
      {library && !library.entries.length && <p className="panel-note">Add your current draft or a preset to start your library.</p>}
      <p className="panel-note">The first four layouts use Ctrl+F9 through Ctrl+F12. Reordering changes these assignments. Reach the rest with Previous or Next. Replacing or removing an entry keeps its previous document in History.</p>
    </dialog>
    <dialog ref={confirmationDialog} className="catalog-dialog library-confirm-dialog" aria-labelledby="library-confirm-title" onCancel={() => setConfirmation(null)} onClose={() => setConfirmation(null)}>
      <div className="panel-heading"><h2 id="library-confirm-title">{confirmationTitle}</h2></div>
      {confirmation?.kind === 'rename' && <label className="library-rename-field">Library name<input autoFocus maxLength={120} value={rename} onChange={(event) => setRename(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && rename.trim() && !disabled) void commitConfirmation(); }} /></label>}
      {confirmation?.kind === 'replace' && <>
        <p className="saved-layouts-lede">Replace {confirmation.entry.name} with this draft? The current version is kept in History. The panel keeps its current dashboard.</p>
        <div className="library-replace-previews"><div><p>Current library entry</p><StaticLayout document={confirmation.entry.document} /></div><div><p>Draft</p><StaticLayout document={confirmation.document} /></div></div>
      </>}
      {confirmation?.kind === 'remove' && <>
        <p className="saved-layouts-lede">Remove {confirmation.entry.name}? A copy is kept in History.{library?.activeId === confirmation.entry.id && ' The panel keeps showing it.'}</p>
        {shifted.length > 0 && <div className="library-shortcut-shifts"><p>Shortcuts move:</p><ul>{shifted.map((entry, index) => <li key={entry.id}>{entry.name} becomes <kbd>Ctrl + F{removedIndex + index + 9}</kbd></li>)}</ul></div>}
      </>}
      {error && <p className="saved-layouts-error" role="alert">{error}</p>}
      <div className="library-confirm-actions"><button disabled={working} onClick={() => setConfirmation(null)}>Cancel</button><button className="primary-button" disabled={disabled || (confirmation?.kind === 'rename' && !rename.trim())} onClick={() => void commitConfirmation()}>{confirmation?.kind === 'rename' ? 'Save name' : confirmation?.kind === 'remove' ? 'Remove from library' : 'Replace with draft'}</button></div>
      {error && <button disabled={disabled} onClick={() => { setConfirmation(null); void show(); }}>Refresh library</button>}
    </dialog>
  </>;
}
