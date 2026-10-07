import { validateLayout } from './layout';
import type { Geometry, LayoutDocument, Widget } from './layout';

export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributionAxis = 'horizontal' | 'vertical';
export type LayerDirection = 'front' | 'back' | 'forward' | 'backward';
export type SizeMatch = 'width' | 'height' | 'both';
export interface CanvasGuide { axis: 'x' | 'y'; position: number }
export interface SnapResult { dx: number; dy: number; guides: readonly CanvasGuide[] }
export interface ResizeSnapResult { width: number; height: number; guides: CanvasGuide[] }
export interface CanvasWarning { kind: 'overlap' | 'small'; ids: string[]; message: string }

function integer(value: number, name: string, nonnegative = false): void {
  if (!Number.isSafeInteger(value) || (nonnegative && value < 0)) {
    throw new Error(`${name}: expected ${nonnegative ? 'a nonnegative' : 'a'} safe integer`);
  }
}

function choice<T extends string>(value: T, allowed: readonly T[], name: string): void {
  if (!allowed.includes(value)) throw new Error(`${name}: expected ${allowed.join(', ')}`);
}

function selectedWidgets(doc: LayoutDocument, ids: readonly string[]): Widget[] {
  const requested = new Set(ids);
  return doc.widgets.filter((widget) => requested.has(widget.id));
}

function bounds(widgets: readonly Widget[]): Geometry | null {
  if (!widgets.length) return null;
  let x = Infinity, y = Infinity, right = 0, bottom = 0;
  for (const widget of widgets) {
    x = Math.min(x, widget.x);
    y = Math.min(y, widget.y);
    right = Math.max(right, widget.x + widget.width);
    bottom = Math.max(bottom, widget.y + widget.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

/** IDs are unique, valid, and ordered from the back to the front of the document. */
export function selectionIds(doc: LayoutDocument, ids: readonly string[]): string[] {
  return selectedWidgets(validateLayout(doc), ids).map((widget) => widget.id);
}

export function selectionBounds(doc: LayoutDocument, ids: readonly string[]): Geometry | null {
  return bounds(selectedWidgets(validateLayout(doc), ids));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value)) || 0;
}

function displacement(doc: LayoutDocument, box: Geometry, dx: number, dy: number) {
  return {
    dx: clamp(dx, -box.x, doc.canvas.width - box.x - box.width),
    dy: clamp(dy, -box.y, doc.canvas.height - box.y - box.height),
  };
}

/** Changed documents are detached, including settings/design; no-ops keep their identity. */
function result(original: LayoutDocument, next: LayoutDocument): LayoutDocument {
  return next.widgets.every((widget, index) => {
    const before = original.widgets[index];
    return widget.id === before.id && widget.x === before.x && widget.y === before.y
      && widget.width === before.width && widget.height === before.height;
  }) ? original : next;
}

export function moveSelection(doc: LayoutDocument, ids: readonly string[], dx: number, dy: number): LayoutDocument {
  integer(dx, 'dx');
  integer(dy, 'dy');
  const next = validateLayout(doc);
  const widgets = selectedWidgets(next, ids);
  const box = bounds(widgets);
  if (!box) return doc;
  const delta = displacement(next, box, dx, dy);
  for (const widget of widgets) {
    widget.x += delta.dx;
    widget.y += delta.dy;
  }
  return result(doc, next);
}

/** Alignment uses the original selection bounds, rather than the canvas or moving bounds. */
export function alignSelection(doc: LayoutDocument, ids: readonly string[], mode: Alignment): LayoutDocument {
  choice(mode, ['left', 'center', 'right', 'top', 'middle', 'bottom'], 'mode');
  const next = validateLayout(doc);
  const widgets = selectedWidgets(next, ids);
  const box = bounds(widgets);
  if (!box) return doc;
  for (const widget of widgets) {
    switch (mode) {
      case 'left': widget.x = box.x; break;
      case 'center': widget.x = Math.round(box.x + (box.width - widget.width) / 2); break;
      case 'right': widget.x = box.x + box.width - widget.width; break;
      case 'top': widget.y = box.y; break;
      case 'middle': widget.y = Math.round(box.y + (box.height - widget.height) / 2); break;
      case 'bottom': widget.y = box.y + box.height - widget.height; break;
    }
  }
  return result(doc, next);
}

/** Match the selected reference exactly; positions never shift to accommodate a size. */
export function matchSelectionSize(
  doc: LayoutDocument, ids: readonly string[], referenceId: string, mode: SizeMatch,
): LayoutDocument {
  choice(mode, ['width', 'height', 'both'], 'mode');
  const next = validateLayout(doc);
  const widgets = selectedWidgets(next, ids);
  const reference = widgets.find((widget) => widget.id === referenceId);
  if (widgets.length < 2 || !reference) return doc;
  for (const widget of widgets) {
    const width = mode === 'height' ? widget.width : reference.width;
    const height = mode === 'width' ? widget.height : reference.height;
    if (width > next.canvas.width - widget.x || height > next.canvas.height - widget.y) {
      throw new Error(`Widget "${widget.id}" cannot match the selected size because it would extend outside the canvas.`);
    }
  }
  for (const widget of widgets) {
    if (mode !== 'height') widget.width = reference.width;
    if (mode !== 'width') widget.height = reference.height;
  }
  return result(doc, next);
}

/** Equal gaps span the original outer edges. Explicit gaps may shift the whole row inward. */
export function distributeSelection(
  doc: LayoutDocument, ids: readonly string[], axis: DistributionAxis, gap?: number,
): LayoutDocument {
  choice(axis, ['horizontal', 'vertical'], 'axis');
  if (gap !== undefined) integer(gap, 'gap', true);
  const next = validateLayout(doc);
  const widgets = selectedWidgets(next, ids);
  if (widgets.length < (gap === undefined ? 3 : 2)) return doc;
  const box = bounds(widgets)!;
  const coordinate = axis === 'horizontal' ? 'x' : 'y';
  const size = axis === 'horizontal' ? 'width' : 'height';
  // Stable sort preserves document paint order for equal starting positions.
  const ordered = [...widgets].sort((a, b) => a[coordinate] - b[coordinate]);
  const totalSize = widgets.reduce((sum, widget) => sum + widget[size], 0);
  const spacing = gap ?? (box[size] - totalSize) / (widgets.length - 1);
  let start = box[coordinate];
  if (gap !== undefined) {
    const available = next.canvas[size] - totalSize;
    if (available < 0 || gap > available / (widgets.length - 1)) {
      throw new Error('gap: selection with this spacing does not fit inside the canvas');
    }
    start = Math.min(start, next.canvas[size] - totalSize - gap * (widgets.length - 1));
  }
  let precedingSize = 0;
  for (const [index, widget] of ordered.entries()) {
    // Round absolute positions so fractional gaps cannot accumulate rounding drift.
    const position = Math.round(start + precedingSize + index * spacing);
    if (position < 0 || position > next.canvas[size] - widget[size]) {
      throw new Error('axis: distributed selection does not fit inside the canvas');
    }
    widget[coordinate] = position;
    precedingSize += widget[size];
  }
  return result(doc, next);
}

export function reorderSelection(doc: LayoutDocument, ids: readonly string[], direction: LayerDirection): LayoutDocument {
  choice(direction, ['front', 'back', 'forward', 'backward'], 'direction');
  const next = validateLayout(doc);
  const selected = new Set(selectedWidgets(next, ids).map((widget) => widget.id));
  if (!selected.size) return doc;
  if (direction === 'front' || direction === 'back') {
    const members = next.widgets.filter((widget) => selected.has(widget.id));
    const others = next.widgets.filter((widget) => !selected.has(widget.id));
    next.widgets = direction === 'front' ? [...others, ...members] : [...members, ...others];
  } else if (direction === 'forward') {
    for (let index = next.widgets.length - 2; index >= 0; index--) {
      if (selected.has(next.widgets[index].id) && !selected.has(next.widgets[index + 1].id)) {
        [next.widgets[index], next.widgets[index + 1]] = [next.widgets[index + 1], next.widgets[index]];
      }
    }
  } else {
    for (let index = 1; index < next.widgets.length; index++) {
      if (selected.has(next.widgets[index].id) && !selected.has(next.widgets[index - 1].id)) {
        [next.widgets[index], next.widgets[index - 1]] = [next.widgets[index - 1], next.widgets[index]];
      }
    }
  }
  return result(doc, next);
}

interface SnapCandidate { delta: number; position: number; distance: number }

function snapAxis(
  doc: LayoutDocument, box: Geometry, others: readonly Widget[], axis: 'x' | 'y',
  raw: number, threshold: number, gutter: number,
): SnapCandidate | null {
  const size = axis === 'x' ? 'width' : 'height';
  const start = box[axis], end = start + box[size], center = start + box[size] / 2;
  const limit = doc.canvas[size];
  let best: SnapCandidate | null = null;
  function consider(source: number, target: number): void {
    const distance = Math.abs(target - (source + raw));
    const delta = Math.round(target - source) || 0;
    if (distance > threshold || delta < -start || delta > limit - end) return;
    if (!best || distance < best.distance) best = { delta, position: target, distance };
  }
  // Edges align with edges; centers align with centers. Canvas targets win exact ties.
  consider(start, 0);
  consider(end, limit);
  consider(center, limit / 2);
  consider(start, gutter);
  consider(end, limit - gutter);
  for (const widget of others) {
    const otherStart = widget[axis], otherEnd = otherStart + widget[size];
    for (const source of [start, end]) {
      consider(source, otherStart);
      consider(source, otherEnd);
    }
    consider(center, otherStart + widget[size] / 2);
    consider(start, otherEnd + gutter);
    consider(end, otherStart - gutter);
  }
  return best;
}

/** Deltas are relative to the input document. To disable snapping, use moveSelection directly. */
export function snapSelection(
  doc: LayoutDocument, ids: readonly string[], dx: number, dy: number, threshold = 6, gutter = 24,
): SnapResult {
  integer(dx, 'dx');
  integer(dy, 'dy');
  integer(threshold, 'threshold', true);
  integer(gutter, 'gutter', true);
  const checked = validateLayout(doc);
  const widgets = selectedWidgets(checked, ids);
  const box = bounds(widgets);
  if (!box) return { dx: 0, dy: 0, guides: [] };
  const raw = displacement(checked, box, dx, dy);
  const selected = new Set(widgets.map((widget) => widget.id));
  const others = checked.widgets.filter((widget) => !selected.has(widget.id));
  const x = snapAxis(checked, box, others, 'x', raw.dx, threshold, gutter);
  const y = snapAxis(checked, box, others, 'y', raw.dy, threshold, gutter);
  const guides: CanvasGuide[] = [];
  if (x) guides.push({ axis: 'x', position: x.position });
  if (y) guides.push({ axis: 'y', position: y.position });
  return { dx: x?.delta ?? raw.dx, dy: y?.delta ?? raw.dy, guides };
}

function snapResizeAxis(
  doc: LayoutDocument, widget: Widget, axis: 'x' | 'y', raw: number, threshold: number, gutter: number,
): SnapCandidate | null {
  const size = axis === 'x' ? 'width' : 'height';
  // A stationary handle axis must not acquire a new size or display a guide.
  if (raw === widget[size]) return null;
  const start = widget[axis], limit = doc.canvas[size];
  let best: SnapCandidate | null = null;
  function consider(position: number): void {
    const dimension = position - start;
    const distance = Math.abs(dimension - raw);
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > limit - start || distance > threshold) return;
    if (!best || distance < best.distance) best = { delta: dimension, position, distance };
  }
  // Canvas wins ties, followed by widgets in document paint order.
  consider(0);
  consider(limit);
  consider(gutter);
  consider(limit - gutter);
  for (const other of doc.widgets) {
    if (other.id === widget.id) continue;
    const otherStart = other[axis], otherEnd = otherStart + other[size];
    consider(otherStart);
    consider(otherEnd);
    consider(otherStart - gutter);
    consider(otherEnd + gutter);
    consider(start + other[size]);
  }
  return best;
}

/** Absolute dimensions resize the right/bottom edges while keeping the top-left fixed. */
export function snapResize(
  doc: LayoutDocument, id: string, width: number, height: number, threshold = 6, gutter = 24,
): ResizeSnapResult {
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name}: expected a positive safe integer`);
  }
  integer(threshold, 'threshold', true);
  integer(gutter, 'gutter', true);
  const checked = validateLayout(doc);
  const widget = checked.widgets.find((candidate) => candidate.id === id);
  if (!widget) throw new Error(`Widget ID "${id}" was not found.`);
  const rawWidth = clamp(width, 1, checked.canvas.width - widget.x);
  const rawHeight = clamp(height, 1, checked.canvas.height - widget.y);
  const x = snapResizeAxis(checked, widget, 'x', rawWidth, threshold, gutter);
  const y = snapResizeAxis(checked, widget, 'y', rawHeight, threshold, gutter);
  const guides: CanvasGuide[] = [];
  if (x) guides.push({ axis: 'x', position: x.position });
  if (y) guides.push({ axis: 'y', position: y.position });
  return { width: x?.delta ?? rawWidth, height: y?.delta ?? rawHeight, guides };
}

/** Informational only: touching edges are allowed, and warnings never change a document. */
export function canvasWarnings(doc: LayoutDocument): CanvasWarning[] {
  const { widgets } = validateLayout(doc);
  const warnings: CanvasWarning[] = [];
  for (const widget of widgets) {
    if (widget.width < 120 || widget.height < 60) {
      warnings.push({ kind: 'small', ids: [widget.id], message: `Widget "${widget.id}" may be too small to read.` });
      if (warnings.length === 100) return warnings;
    }
  }
  for (let index = 0; index < widgets.length; index++) {
    const a = widgets[index];
    for (let other = index + 1; other < widgets.length; other++) {
      const b = widgets[other];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        warnings.push({ kind: 'overlap', ids: [a.id, b.id], message: `Widgets "${a.id}" and "${b.id}" overlap.` });
        if (warnings.length === 100) return warnings;
      }
    }
  }
  return warnings;
}
