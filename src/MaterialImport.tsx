import { useEffect, useRef, useState } from 'react';
import type { LayoutDocument, Palette, Widget } from './domain/layout';
import { parseLayout, serializeLayout } from './domain/layout';
import { mergeCustomWidgets, templateWidget, uniqueTemplateId, validateCustomWidgets } from './domain/widgetTemplates';
import type { CustomWidgets as WidgetPack } from './domain/widgetTemplates';
import { parseDraftWidgetImport } from './domain/importWidgets';
import { imageWidget, readImportImage, verifyImportedImages } from './importImages';
import { CardContent, widgetLabel } from './WidgetContent';
import type useCustomWidgets from './useCustomWidgets';
import './import-styles.css';

type Review = { name: string; widgets: Widget[]; document?: LayoutDocument; warnings: string[]; snapshot: { current: WidgetPack; save: (next: WidgetPack) => Promise<boolean> } | null };

export default function MaterialImport({ open, onClose, file, canvas, palette, store, onAdd, onOpen }: {
  open: boolean; onClose: () => void; file: File[] | null; canvas: { width: number; height: number }; palette: Palette;
  store: ReturnType<typeof useCustomWidgets>; onAdd: (widgets: Widget[], backgrounds: readonly string[]) => void; onOpen: (document: LayoutDocument) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), sequence = useRef(0);
  const [review, setReview] = useState<Review | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [backgrounds, setBackgrounds] = useState<string[]>([]);
  const [text, setText] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [reading, setReading] = useState(false), [hover, setHover] = useState(false);
  const [storeLabel, setStoreLabel] = useState('');
  const latestStore = useRef(store); latestStore.current = store;
  useEffect(() => {
    if (review && !review.snapshot && !store.loading && !store.working && !store.error) {
      setReview({ ...review, snapshot: { current: store.document, save: store.save } });
      setStoreLabel(store.storeLabel);
    }
  }, [store, review]);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open) { dialog.current?.close(); sequence.current++; setReading(false); setHover(false); setReview(null); setError(''); setMessage(''); }
  }, [open]);
  useEffect(() => { if (open && file) void readFiles(file); }, [open, file]);

  const fits = (widget: Widget) => widget.width <= canvas.width && widget.height <= canvas.height;
  function show(next: Omit<Review, 'snapshot'>, source: ReturnType<typeof useCustomWidgets>) {
    const settled = source.loading || source.working ? latestStore.current : source;
    setReview({ ...next, snapshot: settled.loading || settled.working || settled.error ? null : { current: settled.document, save: settled.save } });
    setStoreLabel(settled.storeLabel); setSelected(next.widgets.filter(fits).map((widget) => widget.id)); setBackgrounds([]); setError(''); setMessage('');
  }
  async function parseText(raw: string, name: string, images: Awaited<ReturnType<typeof readImportImage>>[] = []): Promise<Omit<Review, 'snapshot'>> {
    if (new TextEncoder().encode(raw).length > 1024 * 1024) throw new Error('Choose a theme or JSON file smaller than 1 MB.');
    if (/\.(sensorpanel|rslcd)$/i.test(name) || !raw.trimStart().startsWith('{')) {
      const { convertExternalTheme } = await import('./domain/externalTheme');
      const converted = convertExternalTheme(raw, images, palette);
      serializeLayout(converted.document);
      return { name, widgets: converted.document.widgets, document: converted.document, warnings: converted.warnings };
    }
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'canvas')) {
      const document = parseLayout(raw);
      return { name, widgets: document.widgets, document, warnings: [] };
    }
    return { name, widgets: parseDraftWidgetImport(raw), warnings: [] };
  }
  async function readFiles(files: readonly File[]) {
    const request = ++sequence.current, source = store;
    setReading(true); setError(''); setReview(null);
    try {
      if (files.length > 32 || files.reduce((sum, item) => sum + item.size, 0) > 16 * 1024 * 1024) throw new Error('Choose at most 32 files totaling less than 16 MB.');
      const documents = files.filter((item) => !/\.(png|jpe?g|webp)$/i.test(item.name));
      if (documents.length > 1) throw new Error('Choose one layout or theme file and its images. Import other layouts separately.');
      const images = [];
      for (const item of files.filter((item) => /\.(png|jpe?g|webp)$/i.test(item.name))) images.push(await readImportImage(item));
      let next: Omit<Review, 'snapshot'>;
      if (documents[0]) {
        if (documents[0].size > 1024 * 1024) throw new Error('Choose a theme or JSON file smaller than 1 MB.');
        next = await parseText(await documents[0].text(), documents[0].name, images);
      } else {
        if (!images.length) throw new Error('Choose a layout, widget JSON, Turing theme or image.');
        next = { name: images.length === 1 ? images[0].name : `${images.length} images`, widgets: images.map((image, index) => imageWidget(image, canvas, index)), warnings: ['Images are embedded as PNG so exports work offline.'] };
      }
      await verifyImportedImages(next.widgets);
      if (request === sequence.current) show(next, source);
    } catch (failure) { if (request === sequence.current) setError(failure instanceof Error ? failure.message : 'Could not read this file. Choose a supported layout, theme or image.'); }
    finally { if (request === sequence.current) setReading(false); }
  }
  async function paste() {
    const request = ++sequence.current, source = store; setReading(true); setReview(null); setError('');
    try { const next = await parseText(text, text.trimStart().startsWith('{') ? 'Pasted JSON' : 'Pasted theme'); await verifyImportedImages(next.widgets); if (request === sequence.current) show(next, source); }
    catch (failure) { if (request === sequence.current) setError(failure instanceof Error ? failure.message : 'Check the pasted JSON or theme.'); }
    finally { if (request === sequence.current) setReading(false); }
  }
  const chosen = review?.widgets.filter((widget) => selected.includes(widget.id)).map((widget) => backgrounds.includes(widget.id) && widget.type === 'image'
    ? { ...widget, x: 0, y: 0, width: canvas.width, height: canvas.height, settings: { ...widget.settings, fit: 'cover' as const } } : widget) ?? [];
  function add() { try { onAdd(chosen, backgrounds); } catch (failure) { setError(failure instanceof Error ? failure.message : 'These widgets could not be added. Your layout is intact.'); } }
  async function save() {
    if (!review?.snapshot) return;
    const request = sequence.current;
    try {
      const widgets: WidgetPack['widgets'] = [];
      for (const widget of chosen) {
        const base = widgetLabel(widget).slice(0, 50) || widget.type;
        let name = base, number = 2;
        while (widgets.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) name = `${base} ${number++}`;
        widgets.push({ id: uniqueTemplateId(widget.id, widgets), name, widget: templateWidget(widget) });
      }
      const merged = mergeCustomWidgets(review.snapshot.current, validateCustomWidgets({ version: 1, widgets }));
      if (await review.snapshot.save(merged.document) && request === sequence.current) { setMessage(`Saved ${merged.added} custom widgets. Skipped ${merged.skipped} identical copies.`); setReview(null); }
    } catch (failure) { if (request === sequence.current) setError(failure instanceof Error ? failure.message : 'Could not save reusable widgets.'); }
  }
  return <dialog ref={dialog} className="catalog-dialog material-import" aria-labelledby="material-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="panel-heading"><h2 id="material-title">Import</h2><button aria-label="Close import" onClick={onClose}>×</button></div>
    <p className="panel-note">Bring in Studio layouts, widget JSON, PNG, JPEG, WebP or a Turing theme.yaml with its images. Review the result before adding it.</p>
    <div className={`material-drop${hover ? ' hovering' : ''}`} onDragOver={(event) => { event.preventDefault(); setHover(true); }} onDragLeave={() => setHover(false)} onDrop={(event) => { event.preventDefault(); setHover(false); void readFiles([...event.dataTransfer.files]); }}>
      <button disabled={reading || store.working} onClick={() => input.current?.click()}>Choose files…</button><span>Or drop files here. Select the theme and its images together.</span>
      <input ref={input} type="file" multiple hidden aria-label="Import material files" accept=".json,.yaml,.yml,.sensorpanel,.rslcd,.png,.jpg,.jpeg,.webp" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void readFiles(files); }} />
    </div>
    <details className="material-paste"><summary>Paste JSON or theme YAML</summary><label>Source<textarea aria-label="Import source text" value={text} onChange={(event) => setText(event.target.value)} rows={5} maxLength={1024 * 1024} spellCheck={false} /></label><button disabled={!text.trim() || store.working} onClick={() => void paste()}>Review pasted content</button></details>
    {reading && <p role="status" className="panel-note">Reading files…</p>}
    {(error || store.error) && <p role="alert" className="recovery-error">{error || store.error}</p>}
    {message && <p role="status" className="panel-note">{message}</p>}
    <details className="material-compatibility"><summary>AIDA64 compatibility</summary><p>SensorPanel files need conversion. Choose a file for a compatibility check. You can import its exported background image and rebuild live sensors with Studio widgets.</p></details>
    {review && <section className="import-review" aria-label="Import review">
      <h3>{review.name}</h3><p className="panel-note">{review.widgets.length} widgets found. Add to layout places selected copies and keeps your palette. Open as layout keeps the source geometry.</p>
      {review.warnings.length > 0 && <details open className="import-warnings"><summary>{review.warnings.length} conversion notes</summary><ul>{review.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className="custom-toolbar"><button onClick={() => setSelected(review.widgets.filter(fits).map((widget) => widget.id))}>Select all that fit</button><button onClick={() => setSelected([])}>Select none</button></div>
      <div className="material-items">{review.widgets.map((widget) => {
        const scale = Math.min(.35, 120 / widget.width, 80 / widget.height);
        return <article key={widget.id}>
          <label><input type="checkbox" aria-label={`Import ${widgetLabel(widget)}`} checked={selected.includes(widget.id)} disabled={!fits(widget)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, widget.id] : ids.filter((id) => id !== widget.id))} /><strong>{widgetLabel(widget)}</strong><span className="mono">{widget.width} × {widget.height}{!fits(widget) && ' / larger than canvas'}</span></label>
          <div className="material-specimen" aria-hidden="true" style={{ width: widget.width * scale, height: widget.height * scale }}><div className={`dashboard-card${widget.type === 'image' ? ' image-card' : ''}`} style={{ left: 0, top: 0, width: widget.width, height: widget.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}><CardContent widget={widget} /></div></div>
          {widget.type === 'image' && <label className="material-background"><input type="checkbox" aria-label={`Use ${widgetLabel(widget)} as background`} checked={backgrounds.includes(widget.id)} onChange={(event) => { setBackgrounds((ids) => event.target.checked ? [...ids, widget.id] : ids.filter((id) => id !== widget.id)); if (event.target.checked && !selected.includes(widget.id)) setSelected((ids) => [...ids, widget.id]); }} />Fill canvas behind widgets</label>}
        </article>;
      })}</div>
      <div className="material-actions"><button disabled={!chosen.length || reading} className="primary-button" onClick={add}>Add {chosen.length} to layout</button><button disabled={!chosen.length || !review.snapshot || store.loading || store.working || Boolean(store.error)} onClick={() => void save()}>Save {chosen.length} custom widgets</button>{review.document && <button onClick={() => { try { onOpen(review.document!); } catch (failure) { setError(String(failure)); } }}>Open as layout…</button>}</div>
      <p className="panel-note">Reusable copies: {storeLabel}. Image-heavy packs may exceed the 256 KB custom widget limit. Export the layout to retain larger images.</p>
    </section>}
    <div className="custom-toolbar"><button onClick={onClose}>Cancel</button></div>
  </dialog>;
}
