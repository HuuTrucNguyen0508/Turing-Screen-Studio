import { useEffect, useRef, useState } from 'react';
import type { Widget } from './domain/layout';
import { mergeCustomWidgets, parseCustomWidgets, placedTemplate, serializeCustomWidgets, templateWidget, uniqueTemplateId, validateCustomWidgets } from './domain/widgetTemplates';
import type { CustomWidget } from './domain/widgetTemplates';
import type useCustomWidgets from './useCustomWidgets';
import { CardContent } from './WidgetContent';
import './custom-widgets.css';

type Action = { kind: 'new'; widget: Widget } | { kind: 'rename' | 'remove' | 'replace'; entry: CustomWidget; widget?: Widget };

export default function CustomWidgets({ store, candidate, onCloseCandidate, open, onClose, getWidget, onAdd }: {
  store: ReturnType<typeof useCustomWidgets>; candidate: Widget | null; onCloseCandidate: () => void;
  open: boolean; onClose: () => void; getWidget: () => Widget | undefined; onAdd: (id: string) => void;
}) {
  const manager = useRef<HTMLDialogElement>(null), edit = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => { if (open && !manager.current?.open) manager.current?.showModal(); if (!open) manager.current?.close(); }, [open]);
  useEffect(() => { if (candidate) { setName((('label' in candidate.settings && candidate.settings.label) || 'Custom widget').slice(0, 60)); setAction({ kind: 'new', widget: candidate }); setError(''); } }, [candidate]);
  useEffect(() => { if (action && !edit.current?.open) edit.current?.showModal(); if (!action) edit.current?.close(); }, [action]);
  function closeEdit() { setAction(null); onCloseCandidate(); }
  function choose(next: Action) { setAction(next); setError(''); setName(next.kind === 'new' ? 'Custom widget' : next.entry.name); }
  async function commit() {
    if (!action) return;
    try {
      const widgets = [...store.document.widgets];
      if (action.kind === 'new') widgets.push({ id: uniqueTemplateId(name, widgets), name: name.trim(), widget: templateWidget(action.widget) });
      else {
        const index = widgets.findIndex((entry) => entry.id === action.entry.id);
        if (index < 0) throw new Error('This custom widget was removed. Refresh the list before trying again.');
        if (action.kind === 'remove') widgets.splice(index, 1);
        else widgets[index] = { ...widgets[index], ...(action.kind === 'rename' ? { name: name.trim() } : { widget: templateWidget(action.widget!) }) };
      }
      if (await store.save(validateCustomWidgets({ version: 1, widgets }))) { setMessage('Custom widgets saved. Cards already placed keep their design.'); closeEdit(); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the custom widget.'); }
  }
  function refresh() { if (action?.kind === 'replace' || action?.kind === 'remove') closeEdit(); void store.refresh(); }
  function download() {
    const url = URL.createObjectURL(new Blob([serializeCustomWidgets(store.document)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'turzx-widgets.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error('Choose a widget file smaller than 256 KB.');
      const merged = mergeCustomWidgets(store.document, parseCustomWidgets(await file.text()));
      if (await store.save(merged.document)) setMessage(`Imported ${merged.added} widgets. Skipped ${merged.skipped} identical copies.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not import custom widgets.'); }
  }
  const disabled = store.loading || store.working || Boolean(store.error);
  return <>
    <dialog ref={manager} className="catalog-dialog custom-widgets-dialog" aria-labelledby="custom-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="panel-heading"><h2 id="custom-title">Custom widgets</h2><button aria-label="Close custom widgets" onClick={onClose}>×</button></div>
      <p className="panel-note">{store.storeLabel}. Add a copy to any layout. Changing a template keeps placed cards intact.</p>
      <div className="custom-toolbar">{store.machineAvailable && <button disabled={store.working} onClick={store.browserOnly ? store.showMachine : store.showBrowser}>{store.browserOnly ? 'Show machine widgets' : 'Show browser widgets'}</button>}<button disabled={disabled} onClick={() => input.current?.click()}>Import widgets…</button><button disabled={store.loading} onClick={download}>Export widgets</button><button disabled={store.working} onClick={refresh}>Refresh widgets</button></div>
      <input ref={input} type="file" accept=".json,application/json" hidden aria-label="Import custom widgets file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void importFile(file); }} />
      {(error || store.error) && <p role="alert" className="recovery-error">{error || store.error}</p>}
      {message && <p role="status" className="panel-note">{message}</p>}
      {store.loading ? <p>Loading custom widgets…</p> : store.document.widgets.length === 0 ? <p className="panel-note">Select a card, adjust it, then choose Save as custom widget.</p> : <div className="custom-list">{store.document.widgets.map((entry) => {
        const widget = placedTemplate(entry), scale = Math.min(0.35, 180 / widget.width, 120 / widget.height);
        return <article key={entry.id}><div className="custom-specimen" style={{ width: widget.width * scale, height: widget.height * scale }}><div className="dashboard-card" style={{ left: 0, top: 0, width: widget.width, height: widget.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}><CardContent widget={widget} /></div></div><div><h3>{entry.name}</h3><span className="mono">{widget.width} × {widget.height} · {widget.type}</span><div className="custom-toolbar"><button disabled={disabled} onClick={() => { onAdd(entry.id); onClose(); }}>Add to layout</button><button disabled={disabled} onClick={() => choose({ kind: 'rename', entry })}>Rename</button><button disabled={disabled || !getWidget()} onClick={() => choose({ kind: 'replace', entry, widget: getWidget() })}>Replace with selected card…</button><button disabled={disabled} onClick={() => choose({ kind: 'remove', entry })}>Remove…</button></div></div></article>;
      })}</div>}
    </dialog>
    <dialog ref={edit} className="catalog-dialog custom-edit-dialog" aria-labelledby="custom-edit-title" onCancel={(event) => { event.preventDefault(); closeEdit(); }}>
      <h2 id="custom-edit-title">{action?.kind === 'new' ? 'Save as custom widget' : action?.kind === 'rename' ? 'Rename custom widget' : action?.kind === 'remove' ? 'Remove custom widget' : 'Replace custom widget'}</h2>
      {action?.kind === 'new' || action?.kind === 'rename' ? <label className="content-field">Widget name<input aria-label="Custom widget name" autoFocus maxLength={60} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !disabled) void commit(); }} /></label> : <p>Confirm {action?.kind === 'remove' ? 'removing' : 'replacing'} {action ? action.entry.name : ''}. Cards already placed keep their content and design.</p>}
      <p className="panel-note">{store.storeLabel}</p>
      {(error || store.error) && <p role="alert" className="recovery-error">{error || store.error}</p>}
      <div className="custom-toolbar"><button disabled={store.working} onClick={closeEdit}>Cancel</button><button disabled={disabled || ((action?.kind === 'new' || action?.kind === 'rename') && !name.trim())} onClick={() => void commit()}>{action?.kind === 'remove' ? 'Remove custom widget' : action?.kind === 'replace' ? 'Replace custom widget' : 'Save widget'}</button>{store.error && <button disabled={store.working} onClick={refresh}>Refresh widgets</button>}</div>
    </dialog>
  </>;
}
