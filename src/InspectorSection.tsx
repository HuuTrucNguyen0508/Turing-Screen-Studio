import { useState } from 'react';
import type { ReactNode } from 'react';

const storageKey = 'turzx-studio.inspector-sections.v1';

function collapsedSections(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

// The inspector remounts for every selection, so the open state lives in storage rather than component state.
export default function InspectorSection({ id, title, detail, className = '', children }: {
  id: string; title: string; detail?: string; className?: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(() => !collapsedSections().includes(id));
  function toggle(next: boolean) {
    if (next === open) return;
    setOpen(next);
    const others = collapsedSections().filter((entry) => entry !== id);
    try { localStorage.setItem(storageKey, JSON.stringify(next ? others : [...others, id])); } catch { /* The choice still applies until the next selection. */ }
  }
  return <details className={`inspector-section ${className}`.trim()} open={open} onToggle={(event) => toggle(event.currentTarget.open)}>
    <summary><h4>{title}</h4>{detail && <span className="section-detail">{detail}</span>}</summary>
    {children}
  </details>;
}
