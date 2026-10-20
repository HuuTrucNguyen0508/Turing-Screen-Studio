import type { RefObject } from 'react';
import { StaticLayout } from './WidgetContent';
import type useDraftRecovery from './useDraftRecovery';
import type { RecoveryEntry } from './domain/recovery';
import type { LayoutPreset } from './domain/widgets';

export function RecoveryDialog({ dialogRef, recovery, error, onRestore, onExport }: {
  dialogRef: RefObject<HTMLDialogElement | null>; recovery: ReturnType<typeof useDraftRecovery>; error: string;
  onRestore: (entry: RecoveryEntry) => void; onExport: (entry: RecoveryEntry) => void;
}) {
  return <dialog ref={dialogRef} className="catalog-dialog recovery-dialog" aria-labelledby="recovery-title" onCancel={(event) => { event.preventDefault(); recovery.close(); }}>
    <div className="panel-heading"><h2 id="recovery-title">Recover a draft</h2><button aria-label="Close draft recovery" onClick={recovery.close}>×</button></div>
    <p>Restore an unfinished draft. The panel keeps its current dashboard.</p>
    {(recovery.error || error) && <p className="recovery-error" role="alert">{recovery.error || error}</p>}
    {recovery.entries.length === 0 && <p>No unfinished drafts were found.</p>}
    <div className="recovery-list">{recovery.entries.map((entry) => <article key={entry.key}>
      {entry.status === 'valid' && <StaticLayout document={entry.record.document} />}
      <div><h3>{entry.status === 'valid' ? entry.record.title : 'Unreadable draft'}</h3><p>{entry.status === 'valid' ? `${new Date(entry.record.time).toLocaleString()} · ${entry.record.document.widgets.length} widgets` : entry.error}</p>
        {entry.status === 'valid' && <><p className="panel-note">{entry.record.source}{recovery.activeElsewhere(entry) ? ' · Open in another tab; restore makes a copy.' : ''}</p><button onClick={() => onRestore(entry)}>Restore draft</button></>}
        <button onClick={() => onExport(entry)}>Export backup</button>
        <button disabled={recovery.activeElsewhere(entry)} onClick={() => recovery.discard(entry)}>Discard draft</button>
      </div>
    </article>)}</div>
    <button onClick={recovery.close}>Keep editing</button>
  </dialog>;
}

export function PresetsDialog({ dialogRef, presets, error, onChoose }: {
  dialogRef: RefObject<HTMLDialogElement | null>; presets: LayoutPreset[]; error: string; onChoose: (preset: LayoutPreset) => void;
}) {
  return <dialog ref={dialogRef} className="catalog-dialog" aria-labelledby="presets-title">
    <div className="panel-heading"><h2 id="presets-title">Create layout from a preset</h2><button aria-label="Close layout presets" onClick={() => dialogRef.current?.close()}>×</button></div>
    <p className="panel-note">A preset replaces the draft and keeps your palette. The panel keeps its current layout until you choose Save to panel.</p>
    {error ? <p className="panel-note" role="alert">{error}</p> : presets.length === 0 ? <p className="panel-note">No ready-made layouts available yet.</p> : <div className="preset-grid">{presets.map((preset) => <button key={preset.id} aria-label={`Create ${preset.name}`} onClick={() => onChoose(preset)}><StaticLayout document={preset.document} /><strong>{preset.name}</strong><span>{preset.description}</span></button>)}</div>}
  </dialog>;
}
