import { useEffect, useRef, useState } from 'react';
import type { LayoutDocument } from './domain/layout';
import { parseLayout, serializeLayout } from './domain/layout';
import type { LayoutPreset } from './domain/widgets';
import { StaticLayout } from './WidgetContent';
import './saved-layouts.css';

export type LayoutSelection = { direction: 'next' | 'previous' } | { id: string } | { slot: number };
type Entry = { id: string; name: string; document: LayoutDocument };
type Library = { entries: Entry[]; revision: string; activeId: string | null };

function parseLibrary(raw: unknown): Library {
  if (!raw || typeof raw !== 'object' || !('entries' in raw) || !Array.isArray(raw.entries)
    || !('revision' in raw) || typeof raw.revision !== 'string' || !('activeId' in raw)
    || (raw.activeId !== null && typeof raw.activeId !== 'string')) throw new Error('Saved layouts could not be read.');
  const entries = raw.entries.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string'
      || !('name' in entry) || typeof entry.name !== 'string' || !('document' in entry)) throw new Error('Invalid saved layout.');
    return { id: entry.id, name: entry.name, document: parseLayout(JSON.stringify(entry.document)) };
  });
  return { entries, revision: raw.revision, activeId: raw.activeId };
}

export default function SavedLayouts({ available, busy, presets, getDocument, onSwitch, onError, onMessage }: {
  available: boolean; busy: boolean; presets: LayoutPreset[]; getDocument: () => LayoutDocument;
  onSwitch: (selection: LayoutSelection) => Promise<{ activeId: string } | null>;
  onError: (message: string) => void; onMessage: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [working, setWorking] = useState(false);
  const operation = useRef(false);
  const [error, setError] = useState('');
  const [presetId, setPresetId] = useState('');
  const callbacks = useRef({ onSwitch, onError, busy });
  callbacks.current = { onSwitch, onError, busy };

  async function refresh() {
    const response = await fetch('/api/layouts');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Saved layouts are unavailable.');
    const next = parseLibrary(data);
    setLibrary(next);
    return next;
  }

  async function show() {
    dialog.current?.showModal();
    setError('');
    if (operation.current) return;
    operation.current = true; setWorking(true);
    try { await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Saved layouts are unavailable.'); }
    finally { operation.current = false; setWorking(false); }
  }

  async function update(entries: Entry[]) {
    if (operation.current || !library) return;
    operation.current = true; setWorking(true); setError('');
    try {
      const response = await fetch('/api/layouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': library.revision },
        body: JSON.stringify({ entries }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) throw new Error('Saved layouts changed elsewhere. Refresh the list before trying again.');
        throw new Error(data.error ?? 'Could not save the layout rotation.');
      }
      setLibrary(parseLibrary(data));
      onMessage('Saved layout rotation. The panel keeps its current dashboard.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the layout rotation.'); }
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

  function addDraft() {
    if (!library) return;
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

  function reorder(index: number, offset: number) {
    if (!library) return;
    const entries = [...library.entries];
    [entries[index], entries[index + offset]] = [entries[index + offset], entries[index]];
    void update(entries);
  }

  const disabled = working || busy;
  return <>
    {available && <button onClick={() => void show()}>Saved layouts</button>}
    <dialog ref={dialog} className="catalog-dialog saved-layouts-dialog" aria-labelledby="saved-layouts-title">
      <div className="panel-heading"><h2 id="saved-layouts-title">Saved layouts</h2><button aria-label="Close saved layouts" onClick={() => dialog.current?.close()}>×</button></div>
      <p className="saved-layouts-lede">Keep dashboards in this order and switch the panel whenever you want. Each changed switch archives the previous configuration. Your draft stays in the editor. Open saved layout to edit the panel's dashboard.</p>
      <div className="rotation-controls"><button disabled={disabled || !library?.entries.length} onClick={() => void switchTo({ direction: 'previous' })}>Previous layout</button><button disabled={disabled || !library?.entries.length} className="primary-button" onClick={() => void switchTo({ direction: 'next' })}>Next layout</button><span><kbd>Ctrl</kbd> + <kbd>F9</kbd> / <kbd>F10</kbd> / <kbd>F11</kbd> / <kbd>F12</kbd></span></div>
      {error && <p className="saved-layouts-error" role="alert">{error}</p>}
      <div className="rotation-add"><button disabled={disabled || !library || library.entries.length >= 12} onClick={addDraft}>Add current draft</button><label>Ready-made layout<select aria-label="Ready-made layout to save" value={presetId} disabled={disabled} onChange={(event) => setPresetId(event.target.value)}><option value="">Choose a preset</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label><button disabled={disabled || !library || !presetId || library.entries.length >= 12} onClick={addPreset}>Add preset</button><button disabled={disabled} onClick={() => void show()}>Refresh list</button></div>
      {library ? <ol className="saved-layout-list">{library.entries.map((entry, index) => <li key={entry.id} className={entry.id === library.activeId ? 'active-layout' : ''}>
        <span className="layout-order" aria-hidden="true">{index + 1}</span><StaticLayout document={entry.document} />
        <div className="saved-layout-info"><h3>{entry.name}</h3><p>{index < 4 && <><kbd>Ctrl + F{index + 9}</kbd> · </>}{entry.document.widgets.length} widgets{entry.id === library.activeId && <span className="on-panel">On panel</span>}</p><div className="saved-layout-actions"><button disabled={disabled} onClick={() => void switchTo({ id: entry.id })}>Use on panel</button><button disabled={disabled} onClick={() => {
          const snapshot = parseLayout(serializeLayout(getDocument()));
          void update(library.entries.map((saved) => saved.id === entry.id ? { ...saved, name: snapshot.name, document: snapshot } : saved));
        }}>Update with draft</button><button disabled={disabled} aria-label={`Remove ${entry.name} from rotation`} onClick={() => void update(library.entries.filter((saved) => saved.id !== entry.id))}>Remove</button></div></div>
        <div className="layout-order-controls"><button disabled={disabled || index === 0} aria-label={`Move ${entry.name} earlier`} onClick={() => reorder(index, -1)}>↑</button><button disabled={disabled || index === library.entries.length - 1} aria-label={`Move ${entry.name} later`} onClick={() => reorder(index, 1)}>↓</button></div>
      </li>)}</ol> : <p className="panel-note">{working ? 'Loading saved layouts…' : 'Refresh the list to load saved layouts.'}</p>}
      {library && !library.entries.length && <p className="panel-note">Add your current draft or a preset to start a layout rotation.</p>}
      <p className="panel-note">The first four layouts use Ctrl+F9 through Ctrl+F12. Reordering changes these assignments. Keep up to 12 layouts and reach the rest with Previous or Next. Updating or removing an entry archives its older configuration and keeps the current panel intact.</p>
    </dialog>
  </>;
}
