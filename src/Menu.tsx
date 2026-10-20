import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, Ref } from 'react';

export type MenuEntry = { label: string; onSelect: () => void; disabled?: boolean; title?: string } | 'separator';

/** A menu button: arrows move between items, Escape and Tab close it, focus returns to the button. */
export function Menu({ label, items, triggerRef, className = '' }: { label: string; items: MenuEntry[]; triggerRef?: Ref<HTMLButtonElement>; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  // Separators only appear between items.
  const entries = items.filter((item, index) => item !== 'separator' || (index > 0 && items[index - 1] !== 'separator' && items.slice(index + 1).some((next) => next !== 'separator')));
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const focusItem = (index: number) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    buttons.at(index % Math.max(buttons.length, 1))?.focus();
  };
  useEffect(() => {
    if (!open) return;
    focusItem(0);
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [open]);
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); focusItem(index + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusItem(index <= 0 ? buttons.length - 1 : index - 1); }
    else if (event.key === 'Home') { event.preventDefault(); focusItem(0); }
    else if (event.key === 'End') { event.preventDefault(); focusItem(buttons.length - 1); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    else if (event.key === 'Tab') setOpen(false);
  }
  return <div ref={root} className={`menu ${className}`} onKeyDown={open ? keys : undefined}>
    <button ref={(node) => { trigger.current = node; if (typeof triggerRef === 'function') triggerRef(node); else if (triggerRef) triggerRef.current = node; }}
      className="menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}>
      {label}<svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
    </button>
    {open && <div ref={list} id={id} role="menu" aria-label={label} className="menu-list">
      {entries.map((item, index) => item === 'separator' ? <div key={`separator-${index}`} role="separator" /> : <button key={item.label} role="menuitem" disabled={item.disabled} title={item.title}
        onClick={() => { setOpen(false); trigger.current?.focus(); item.onSelect(); }}>{item.label}</button>)}
    </div>}
  </div>;
}

/** A non-modal panel anchored to its button. Escape closes it and returns focus to the button. */
export function Popover({ label, buttonLabel, title, className = '', children, open: controlled, onOpenChange }: {
  label: ReactNode; buttonLabel?: string; title: string; className?: string; children: (close: () => void) => ReactNode;
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = (value: boolean) => { setUncontrolled(value); onOpenChange?.(value); };
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const latest = useRef(setOpen);
  latest.current = setOpen;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) latest.current(false); };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div ref={root} className={`popover ${className}`}
    onKeyDown={(event) => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <button ref={trigger} className="popover-trigger" aria-label={buttonLabel} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>{label}</button>
    {open && <section id={id} className="popover-panel" role="region" aria-label={title}>{children(close)}</section>}
  </div>;
}
