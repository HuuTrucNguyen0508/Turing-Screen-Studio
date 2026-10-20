import { createSampleLayout, validateLayout } from './layout';
import type { Geometry, LayoutDocument, Palette, Widget } from './layout';

/** Recent widget copies, kept in browser storage so they survive switching layouts and reloads. */
export const CLIPBOARD_LIMIT = 12;
export const CLIPBOARD_STORAGE_KEY = 'turzx-studio.widget-clipboard.v1';
const MAX_ENTRY_WIDGETS = 64;
const GUTTER = 24;

export interface ClipEntry {
  readonly id: string;
  readonly name: string;
  readonly copiedAt: number;
  /** Name of the layout the copy came from. */
  readonly source: string;
  readonly canvas: { readonly width: number; readonly height: number };
  /** Detached copies with their original geometry, in paint order. */
  readonly widgets: readonly Widget[];
}

export interface WidgetClipboard { readonly version: 1; readonly entries: readonly ClipEntry[] }

export type PastePlacement = 'original' | 'nearby' | 'offset';
export interface PasteResult {
  readonly document: LayoutDocument;
  readonly ids: readonly string[];
  readonly placement: PastePlacement;
  readonly scaled: boolean;
}

export const emptyClipboard: WidgetClipboard = Object.freeze({ version: 1, entries: Object.freeze([]) as readonly ClipEntry[] });

function checkedWidgets(widgets: unknown, canvas: { width: number; height: number }): Widget[] {
  // The layout contract validates every widget field, including geometry against the source canvas.
  return validateLayout({ version: 1, name: 'Clipboard', canvas: { width: canvas.width, height: canvas.height }, palette: createSampleLayout().palette, widgets }).widgets;
}

/** Copy the selected widgets in paint order. Throws when nothing is selected. */
export function clipEntry(doc: LayoutDocument, ids: readonly string[], meta: { id: string; name: string; copiedAt: number }): ClipEntry {
  const selected = doc.widgets.filter((widget) => ids.includes(widget.id));
  if (!selected.length) throw new Error('Select a card to copy.');
  return entry({ ...meta, source: doc.name, canvas: { ...doc.canvas }, widgets: checkedWidgets(selected, doc.canvas) });
}

function entry(value: ClipEntry): ClipEntry {
  if (typeof value.id !== 'string' || !value.id || value.id.length > 80) throw new Error('Clipboard entry ID is invalid.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120) throw new Error('Clipboard entry name is invalid.');
  if (typeof value.source !== 'string' || value.source.length > 200) throw new Error('Clipboard entry source is invalid.');
  if (typeof value.copiedAt !== 'number' || !Number.isFinite(value.copiedAt)) throw new Error('Clipboard entry time is invalid.');
  if (!Array.isArray(value.widgets) || !value.widgets.length || value.widgets.length > MAX_ENTRY_WIDGETS) throw new Error('Clipboard entry needs 1 to 64 widgets.');
  const canvas = value.canvas as unknown as Record<string, unknown> | null;
  if (!canvas || typeof canvas !== 'object') throw new Error('Clipboard entry canvas is invalid.');
  const widgets = checkedWidgets(value.widgets, { width: canvas.width as number, height: canvas.height as number });
  return Object.freeze({
    id: value.id, name: value.name.trim(), copiedAt: value.copiedAt, source: value.source,
    canvas: Object.freeze({ width: canvas.width as number, height: canvas.height as number }),
    widgets: Object.freeze(widgets),
  });
}

/** Widget type shared by every copied card, or "group" for mixed or multiple cards. */
export function clipType(clip: ClipEntry): Widget['type'] | 'group' {
  return clip.widgets.length === 1 ? clip.widgets[0].type : 'group';
}

export function clipBounds(widgets: readonly Geometry[]): Geometry {
  const x = Math.min(...widgets.map((widget) => widget.x)), y = Math.min(...widgets.map((widget) => widget.y));
  return {
    x, y,
    width: Math.max(...widgets.map((widget) => widget.x + widget.width)) - x,
    height: Math.max(...widgets.map((widget) => widget.y + widget.height)) - y,
  };
}

function contentKey(clip: ClipEntry): string {
  return JSON.stringify([clip.canvas, clip.widgets]);
}

/** Newest first. Copying the same cards again moves the earlier copy to the top. */
export function rememberClip(board: WidgetClipboard, clip: ClipEntry): WidgetClipboard {
  const key = contentKey(clip);
  const rest = board.entries.filter((existing) => existing.id !== clip.id && contentKey(existing) !== key);
  return Object.freeze({ version: 1, entries: Object.freeze([clip, ...rest].slice(0, CLIPBOARD_LIMIT)) });
}

/** Merge shared history with copies retained in this tab, using the same copy identity rules. */
export function mergeClipboard(local: WidgetClipboard, stored: WidgetClipboard): WidgetClipboard {
  return [...local.entries, ...stored.entries]
    .sort((a, b) => a.copiedAt - b.copiedAt)
    .reduce(rememberClip, emptyClipboard);
}

export function forgetClip(board: WidgetClipboard, id: string): WidgetClipboard {
  return Object.freeze({ version: 1, entries: Object.freeze(board.entries.filter((clip) => clip.id !== id)) });
}

export function serializeClipboard(board: WidgetClipboard): string {
  return JSON.stringify({ version: 1, entries: board.entries });
}

/** Stored data is untrusted. Unreadable entries are dropped one by one; the rest survive. */
export function parseClipboard(text: string | null): { clipboard: WidgetClipboard; dropped: number } {
  if (text === null) return { clipboard: emptyClipboard, dropped: 0 };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { clipboard: emptyClipboard, dropped: 1 }; }
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { entries?: unknown }).entries)) {
    return { clipboard: emptyClipboard, dropped: 1 };
  }
  const entries: ClipEntry[] = [];
  let dropped = 0;
  for (const value of (raw as { entries: unknown[] }).entries) {
    try {
      const clip = entry(value as ClipEntry);
      if (entries.some((existing) => existing.id === clip.id)) throw new Error('Duplicate clipboard entry.');
      if (entries.length >= CLIPBOARD_LIMIT) throw new Error('Clipboard is full.');
      entries.push(clip);
    } catch { dropped++; }
  }
  return { clipboard: Object.freeze({ version: 1, entries: Object.freeze(entries) }), dropped };
}

/** A small document showing just the copied cards, for tray thumbnails. */
export function clipPreview(clip: ClipEntry, palette: Palette): LayoutDocument {
  const bounds = clipBounds(clip.widgets);
  return {
    version: 1, name: clip.name, chrome: 'none', palette, canvas: { width: bounds.width, height: bounds.height },
    widgets: clip.widgets.map((widget) => ({ ...widget, x: widget.x - bounds.x, y: widget.y - bounds.y })),
  };
}

function overlaps(a: Geometry, b: Geometry): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function freshId(taken: Set<string>, id: string): string {
  if (!taken.has(id)) return id;
  const base = id.replace(/-\d+$/, '') || id;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

/** Scale the group down uniformly only when it is larger than the target canvas. */
function fitGroup(widgets: readonly Widget[], canvas: LayoutDocument['canvas']) {
  const bounds = clipBounds(widgets);
  const factor = Math.min(1, canvas.width / bounds.width, canvas.height / bounds.height);
  const relative = widgets.map((widget) => factor === 1
    ? { ...widget, x: widget.x - bounds.x, y: widget.y - bounds.y }
    : {
      ...widget,
      x: Math.floor((widget.x - bounds.x) * factor), y: Math.floor((widget.y - bounds.y) * factor),
      width: Math.max(1, Math.floor(widget.width * factor)), height: Math.max(1, Math.floor(widget.height * factor)),
    });
  const size = clipBounds(relative);
  return { relative, origin: { x: bounds.x, y: bounds.y }, width: size.x + size.width, height: size.y + size.height, scaled: factor < 1 };
}

/**
 * Paste prefers the copied position. When that overlaps existing cards it takes the
 * nearest free spot, and on a full canvas it offsets by one gutter. Geometry stays integer.
 */
export function pasteClip(doc: LayoutDocument, clip: ClipEntry): PasteResult {
  const group = fitGroup(clip.widgets, doc.canvas);
  const maxX = doc.canvas.width - group.width, maxY = doc.canvas.height - group.height;
  const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
  const preferred = { x: clamp(group.origin.x, maxX), y: clamp(group.origin.y, maxY) };
  const free = (x: number, y: number) => group.relative.every((widget) =>
    doc.widgets.every((other) => !overlaps({ ...widget, x: widget.x + x, y: widget.y + y }, other)));

  let position = preferred;
  let placement: PastePlacement = 'original';
  if (!free(preferred.x, preferred.y)) {
    const xs = new Set([preferred.x, 0, maxX]), ys = new Set([preferred.y, 0, maxY]);
    for (const other of doc.widgets) {
      for (const x of [other.x, other.x + other.width + GUTTER, other.x - group.width - GUTTER]) if (x >= 0 && x <= maxX) xs.add(x);
      for (const y of [other.y, other.y + other.height + GUTTER, other.y - group.height - GUTTER]) if (y >= 0 && y <= maxY) ys.add(y);
    }
    const candidates = [...xs].flatMap((x) => [...ys].map((y) => ({ x, y, distance: (x - preferred.x) ** 2 + (y - preferred.y) ** 2 })))
      .sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
    const spot = candidates.find((candidate) => free(candidate.x, candidate.y));
    if (spot) { position = { x: spot.x, y: spot.y }; placement = 'nearby'; }
    else {
      const forward = { x: clamp(preferred.x + GUTTER, maxX), y: clamp(preferred.y + GUTTER, maxY) };
      position = forward.x === preferred.x && forward.y === preferred.y
        ? { x: clamp(preferred.x - GUTTER, maxX), y: clamp(preferred.y - GUTTER, maxY) } : forward;
      placement = 'offset';
    }
  }

  const taken = new Set(doc.widgets.map((widget) => widget.id));
  const pasted = group.relative.map((widget) => {
    const id = freshId(taken, widget.id);
    taken.add(id);
    return { ...widget, id, x: widget.x + position.x, y: widget.y + position.y } as Widget;
  });
  const document = validateLayout({ ...doc, widgets: [...doc.widgets, ...pasted] });
  return { document, ids: pasted.map((widget) => widget.id), placement, scaled: group.scaled };
}

/** Remove several cards in one edit, for Cut. */
export function removeSelection(doc: LayoutDocument, ids: readonly string[]): LayoutDocument {
  return validateLayout({ ...doc, widgets: doc.widgets.filter((widget) => !ids.includes(widget.id)) });
}
