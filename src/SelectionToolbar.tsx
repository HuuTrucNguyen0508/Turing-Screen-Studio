import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, Ref } from 'react';
import { alignSelection } from './domain/canvas';
import type { Alignment } from './domain/canvas';
import type { LayoutDocument, Widget } from './domain/layout';
import { widgetLabel } from './WidgetContent';
import { AlignmentIcon } from './ToolIcons';

export default function SelectionToolbar({ document, widget, ids, style, docked, busy, toolbarRef, compactResize, onResize, onChange, onDuplicate, onDelete, onDetails }: {
  document: LayoutDocument; widget: Widget; ids: readonly string[]; style: CSSProperties; busy: boolean;
  toolbarRef: Ref<HTMLDivElement>;
  compactResize: boolean; onResize: () => void;
  docked: boolean;
  onChange: (document: LayoutDocument) => void; onDuplicate: () => void; onDelete: () => void; onDetails: () => void;
}) {
  const align = useRef<HTMLDetailsElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!align.current || !menu.current) return;
      const anchor = align.current.getBoundingClientRect();
      const panel = align.current.closest('.canvas-stage')!.getBoundingClientRect();
      const bounds = menu.current.getBoundingClientRect();
      const left = Math.max(8, panel.left + 8), right = Math.min(innerWidth - 8, panel.right - 8);
      const top = Math.max(8, panel.top + 8), bottom = Math.min(innerHeight - 8, panel.bottom - 8);
      const y = anchor.bottom + bounds.height + 6 <= bottom ? anchor.bottom + 6 : anchor.top - bounds.height - 6;
      setPosition({ left: Math.max(left, Math.min(anchor.left, right - bounds.width)), top: Math.max(top, Math.min(y, bottom - bounds.height)) });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); align.current?.removeAttribute('open'); align.current?.querySelector('summary')?.focus(); }
    };
    const outside = (event: PointerEvent) => { if (!align.current?.contains(event.target as Node)) align.current?.removeAttribute('open'); };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.addEventListener('keydown', escape); window.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.removeEventListener('keydown', escape); window.removeEventListener('pointerdown', outside); };
  }, [open, style.left, style.top]);
  return <div ref={toolbarRef} className={`selection-toolbar${docked ? ' docked' : ''}`} data-selection-toolbar data-busy={busy} role="group" aria-label="Selection actions" style={style}
    onPointerDown={(event) => event.stopPropagation()}>
    <span className="selection-toolbar-name" title={widgetLabel(widget)}>{ids.length > 1 ? `${ids.length} cards` : widgetLabel(widget)}</span>
    {ids.length === 1 && <>
      {compactResize && <button disabled={busy} onClick={onResize}>Resize</button>}
      <button disabled={busy} aria-label="Duplicate selected widget" onClick={onDuplicate}>Duplicate</button>
      <button disabled={busy} className="remove-button" aria-label="Delete selected widget" onClick={onDelete}>Delete</button>
    </>}
    {ids.length > 1 && <details ref={align} className="selection-align" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Align</summary>
      <div ref={menu} style={position} role="group" aria-label="Align selected cards">{(['left', 'center', 'right', 'top', 'middle', 'bottom'] as Alignment[]).map((mode) =>
        <button key={mode} disabled={busy} aria-label={`Selection align ${mode}`} title={`Align ${mode}`} onClick={(event) => {
          onChange(alignSelection(document, ids, mode));
          event.currentTarget.closest('details')?.removeAttribute('open');
          event.currentTarget.closest('.canvas-stage')?.querySelector<HTMLElement>('[data-primary="true"]')?.focus({ preventScroll: true });
        }}><AlignmentIcon mode={mode} /></button>)}
      </div>
    </details>}
    <button disabled={busy} aria-label="Edit selection details" onClick={onDetails}>Edit details</button>
  </div>;
}
