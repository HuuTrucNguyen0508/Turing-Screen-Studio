import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Widget } from './domain/layout';
import { designAligns, designColors, elementSpecs, resolveElements } from './domain/design';
import type { ElementDesign, ResolvedElement, WidgetDesignPatch } from './domain/design';
import './design-styles.css';

export type DesignPatch = WidgetDesignPatch;

const DEFAULT_PADDING = 29;
const alignLabels = { start: 'Left', center: 'Center', end: 'Right' } as const;
const colorLabels = { text: 'Text', muted: 'Muted', primary: 'Primary', secondary: 'Secondary' } as const;

/** Whole-number field: a local draft that commits on Enter or blur and restores on Escape. */
function IntField({ label, value, min, max, unit = 'px', emptyValue, inline = false, onCommit }: {
  label: string; value: number; min: number; max: number; unit?: string; emptyValue?: number; inline?: boolean;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(String(value)); setError(''); }, [value]);
  const message = `Enter a whole number from ${min < 0 ? `−${-min}` : min} to ${max}.`;
  function commit(text = draft) {
    const trimmed = text.trim().replace(/^[−–]/, '-');
    if (!trimmed && emptyValue !== undefined) { setError(''); setDraft(String(emptyValue)); onCommit(null); return; }
    if (!/^-?\d+$/.test(trimmed)) { setError(message); return; }
    const number = Number(trimmed);
    if (number < min || number > max) { setError(message); return; }
    setError('');
    if (number !== value) onCommit(number);
    else setDraft(String(value));
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Escape') { event.stopPropagation(); setDraft(String(value)); setError(''); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const step = (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1);
      const next = Math.min(max, Math.max(min, value + step));
      setDraft(String(next)); setError('');
      if (next !== value) onCommit(next);
    }
  }
  return <label className={`design-field${inline ? ' inline' : ''}`}>
    <span className="design-field-label">{label}</span>
    <span className={`design-input${error ? ' invalid' : ''}`}>
      <input aria-label={label} inputMode="numeric" value={draft} aria-invalid={Boolean(error)}
        onChange={(event) => { setDraft(event.target.value); setError(''); }}
        onBlur={() => commit()} onKeyDown={onKeyDown} />
      <span aria-hidden="true">{unit}</span>
    </span>
    {error && <span className="field-error" role="alert">{error}</span>}
  </label>;
}

function AlignGlyph({ align }: { align: ElementDesign['align'] }) {
  const x = align === 'start' ? 2 : align === 'center' ? 7 : 12;
  return <svg viewBox="0 0 14 12" width="14" height="12" aria-hidden="true">
    <line x1={x} y1="0.5" x2={x} y2="11.5" className="glyph-anchor" />
    {[2.5, 6, 9.5].map((y, row) => {
      const length = row === 1 ? 6 : 9;
      const start = align === 'start' ? 4 : align === 'center' ? 7 - length / 2 : 10 - length;
      return <line key={y} x1={start} y1={y} x2={start + length} y2={y} />;
    })}
  </svg>;
}

function ElementPanel({ widget, resolved, design, onCommit }: {
  widget: Widget; resolved: ResolvedElement; design: ElementDesign | undefined; onCommit: (patch: DesignPatch) => void;
}) {
  const name = resolved.name.toLowerCase();
  const set = (patch: Partial<ElementDesign>) => onCommit({ element: resolved.id, set: patch });
  const offInContent = widget.type === 'clock' && resolved.id === 'date' && !widget.settings.showDate;
  const outside = resolved.x < 0 || resolved.x > widget.width || resolved.y < 0 || resolved.y > widget.height;
  return <div className="design-element-body" id={`design-element-${resolved.id}`}>
    <div className="design-control">
      <span className="design-field-label" id={`design-align-${resolved.id}`}>Align</span>
      <div className="design-segmented" role="group" aria-labelledby={`design-align-${resolved.id}`}>
        {designAligns.map((align) => <button key={align} type="button" aria-pressed={resolved.align === align}
          aria-label={alignLabels[align]} title={alignLabels[align]}
          onClick={() => { if (resolved.align !== align) set({ align }); }}><AlignGlyph align={align} /></button>)}
      </div>
    </div>
    <IntField label="X offset" value={design?.dx ?? 0} min={-512} max={512} onCommit={(dx) => set({ dx: dx ?? 0 })} />
    <IntField label="Y offset" value={design?.dy ?? 0} min={-512} max={512} onCommit={(dy) => set({ dy: dy ?? 0 })} />
    <IntField label="Size" value={resolved.size} min={8} max={160} onCommit={(size) => { if (size !== null) set({ size }); }} />
    <fieldset className="design-colors">
      <legend className="design-field-label">Color <span>{colorLabels[resolved.color]}</span></legend>
      <div className="design-swatches">
        {designColors.map((color) => <label key={color} className="design-swatch" title={colorLabels[color]}>
          <input type="radio" name={`design-color-${widget.id}-${resolved.id}`} className="visually-hidden"
            checked={resolved.color === color} aria-label={colorLabels[color]}
            onChange={() => set({ color })} />
          <span style={{ background: `var(--${color})` }} aria-hidden="true" />
        </label>)}
      </div>
    </fieldset>
    <label className="theme-choice design-hide">
      <input type="checkbox" checked={offInContent || resolved.hidden} disabled={offInContent}
        onChange={(event) => set({ hidden: event.target.checked })} />
      Hide {name}{offInContent && <span className="mono">Off in content</span>}
    </label>
    {outside && !resolved.hidden && <p className="design-warning" role="status">{resolved.name} starts outside the card and may be clipped.</p>}
    <button type="button" className="design-link" disabled={!design}
      onClick={() => onCommit({ element: resolved.id, reset: true })}>Reset {name}</button>
  </div>;
}

export default function DesignEditor({ widget, onCommit, onInspect }: {
  widget: Widget; onCommit: (patch: DesignPatch) => void; onInspect?: (element: string | null) => void;
}) {
  const specs = elementSpecs(widget);
  const resolved = resolveElements(widget);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<string | null>(null);
  const inspect = useRef(onInspect);
  useEffect(() => { inspect.current = onInspect; });

  const fallback = resolved.find((element) => !element.hidden)?.id ?? specs[0]?.id ?? null;
  const focus = remembered && specs.some((spec) => spec.id === remembered) ? remembered : fallback;
  const supported = specs.length > 0;

  useEffect(() => {
    if (!open || !supported) return;
    inspect.current?.(focus);
    return () => inspect.current?.(null);
  }, [open, supported, focus, widget.id]);

  function toggle(id: string) {
    setRemembered(id);
    setExpanded((current) => current === id ? null : id);
  }

  const padding = widget.design?.padding ?? DEFAULT_PADDING;
  return <details className="inspector-section design-section" open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <h4>Design</h4>
      {supported && <span className="mono">{widget.design ? 'Edited' : 'Default'}</span>}
    </summary>
    {!supported ? <p className="panel-note design-note">Internal design controls start with clocks. You can save this card as a custom widget.</p> : <>
      <IntField label="Side padding" value={padding} min={0} max={64} emptyValue={DEFAULT_PADDING} inline
        onCommit={(next) => onCommit({ padding: next })} />
      <div className="design-elements" role="list" aria-label="Elements">
        {resolved.map((element) => {
          const isOpen = expanded === element.id;
          return <div key={element.id} role="listitem" className={`design-element${isOpen ? ' open' : ''}${focus === element.id ? ' inspected' : ''}`}>
            <button type="button" className="design-element-row" aria-expanded={isOpen}
              aria-controls={isOpen ? `design-element-${element.id}` : undefined} onClick={() => toggle(element.id)}>
              <span className="design-chevron" aria-hidden="true" />
              <span className={`design-element-name${element.hidden ? ' hidden' : ''}`}>{element.name}</span>
              <span className="design-dot" style={{ background: `var(--${element.color})` }} aria-hidden="true" />
              <span className="mono">{element.hidden ? 'hidden' : `${element.size}`}</span>
            </button>
            {isOpen && <ElementPanel widget={widget} resolved={element}
              design={widget.design?.elements?.[element.id]} onCommit={onCommit} />}
          </div>;
        })}
      </div>
      <button type="button" className="design-link design-reset" disabled={!widget.design}
        onClick={() => onCommit({ reset: true })}>Reset design</button>
    </>}
  </details>;
}
