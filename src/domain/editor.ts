import { parseLayout, serializeLayout, validateLayout } from './layout';
import type { LayoutDocument } from './layout';
import { selectionIds } from './canvas';
import { parseDraftTarget } from './draft';
import type { DraftTarget } from './draft';

export const EDITOR_HISTORY_LIMIT = 100;

export interface EditorSnapshot {
  readonly document: LayoutDocument;
  readonly selectedId: string | null;
  readonly selectedIds: readonly string[];
  readonly target: DraftTarget;
}

export interface EditorState extends EditorSnapshot {
  readonly baseline: string;
  readonly baseRevision: string | null;
  readonly past: readonly EditorSnapshot[];
  readonly future: readonly EditorSnapshot[];
  readonly gesture: EditorSnapshot | null;
}

export interface EditorOptions {
  selectedId?: string | null;
  selectedIds?: readonly string[];
  baseline?: string;
  baseRevision?: string | null;
  target?: DraftTarget;
}

function freezeDocument(document: LayoutDocument): LayoutDocument {
  Object.freeze(document.canvas);
  Object.freeze(document.palette);
  for (const widget of document.widgets) {
    Object.freeze(widget.settings);
    if ('design' in widget && widget.design) {
      const design = widget.design as { elements?: Record<string, object> };
      if (design.elements) { Object.values(design.elements).forEach(Object.freeze); Object.freeze(design.elements); }
      Object.freeze(design);
    }
    Object.freeze(widget);
  }
  Object.freeze(document.widgets);
  return Object.freeze(document);
}

function snapshot(document: LayoutDocument, selectedId: string | null, target: DraftTarget, ids: readonly string[] = selectedId ? [selectedId] : []): EditorSnapshot {
  const checked = freezeDocument(validateLayout(document));
  const selectedIds = Object.freeze(selectionIds(checked, ids));
  return Object.freeze({
    document: checked, selectedIds,
    selectedId: selectedId && selectedIds.includes(selectedId) ? selectedId : selectedIds[0] ?? null,
    target: Object.freeze(parseDraftTarget(target)),
  });
}

function state(value: EditorState): EditorState {
  Object.freeze(value.past);
  Object.freeze(value.future);
  return Object.freeze(value);
}

/** Documents are detached and frozen. Invalid documents throw before any state changes. */
export function createEditor(document: LayoutDocument, options: EditorOptions = {}): EditorState {
  const current = snapshot(document, options.selectedId === undefined ? document.widgets[0]?.id ?? null : options.selectedId, options.target ?? { kind: options.baseRevision ? 'panel' : 'local' }, options.selectedIds);
  const baseline = options.baseline === undefined
    ? serializeLayout(current.document)
    : serializeLayout(parseLayout(options.baseline));
  const baseRevision = options.baseRevision ?? null;
  if (baseRevision !== null && (typeof baseRevision !== 'string' || !baseRevision.trim())) {
    throw new Error('Editor base revision must be a nonempty string or null.');
  }
  return state({ ...current, baseline, baseRevision, past: [], future: [], gesture: null });
}

export function editorDirty(editor: EditorState): boolean {
  return serializeLayout(editor.document) !== editor.baseline;
}

function sameDocument(left: LayoutDocument, right: LayoutDocument): boolean {
  return serializeLayout(left) === serializeLayout(right);
}

function appendHistory(history: readonly EditorSnapshot[], entry: EditorSnapshot): readonly EditorSnapshot[] {
  return [...history.slice(-(EDITOR_HISTORY_LIMIT - 1)), entry];
}

/** Selection alone does not consume history or discard a redo branch. */
export function commitEdit(editor: EditorState, next: LayoutDocument, selectedId?: string | null, selectedIds?: readonly string[]): EditorState {
  if (editor.gesture) return finishGesture(previewGesture(editor, next, selectedId, selectedIds));
  const current = snapshot(next, selectedId === undefined ? editor.selectedId : selectedId, editor.target, selectedIds ?? (selectedId === undefined ? editor.selectedIds : selectedId ? [selectedId] : []));
  if (sameDocument(editor.document, current.document)) {
    return sameSelection(editor, current) ? editor : state({ ...editor, ...current });
  }
  return state({
    ...editor, ...current,
    past: appendHistory(editor.past, snapshot(editor.document, editor.selectedId, editor.target, editor.selectedIds)),
    future: [],
  });
}

/** Call once at pointer down. Repeated begin calls keep the original transaction. */
export function beginGesture(editor: EditorState): EditorState {
  if (editor.gesture) return editor;
  return state({ ...editor, gesture: snapshot(editor.document, editor.selectedId, editor.target, editor.selectedIds) });
}

/** Live pointer frames never consume history. A gesture must already be open. */
export function previewGesture(editor: EditorState, next: LayoutDocument, selectedId?: string | null, selectedIds?: readonly string[]): EditorState {
  if (!editor.gesture) throw new Error('Begin an editor gesture before previewing it.');
  const current = snapshot(next, selectedId === undefined ? editor.selectedId : selectedId, editor.target, selectedIds ?? (selectedId === undefined ? editor.selectedIds : selectedId ? [selectedId] : []));
  if (sameDocument(editor.document, current.document) && sameSelection(editor, current)) return editor;
  return state({ ...editor, ...current });
}

/** Cancel restores document and selection; finishing a changed drag creates one undo step. */
export function finishGesture(editor: EditorState, cancel = false): EditorState {
  if (!editor.gesture) return editor;
  const origin = editor.gesture;
  if (cancel) return state({ ...editor, ...origin, gesture: null });
  if (sameDocument(origin.document, editor.document)) return state({ ...editor, gesture: null });
  return state({ ...editor, past: appendHistory(editor.past, origin), future: [], gesture: null });
}

/** An open gesture is cancelled before moving through committed history. */
export function undoEdit(editor: EditorState): EditorState {
  const current = finishGesture(editor, true);
  const previous = current.past.at(-1);
  if (!previous) return current;
  return state({
    ...current, ...previous, target: current.target, past: current.past.slice(0, -1),
    future: appendHistory(current.future, snapshot(current.document, current.selectedId, current.target, current.selectedIds)),
  });
}

export function redoEdit(editor: EditorState): EditorState {
  const current = finishGesture(editor, true);
  const next = current.future.at(-1);
  if (!next) return current;
  return state({
    ...current, ...next, target: current.target, future: current.future.slice(0, -1),
    past: appendHistory(current.past, snapshot(current.document, current.selectedId, current.target, current.selectedIds)),
  });
}

/** Open/recover a document with a fresh history. By default it becomes the clean baseline. */
export function replaceEditor(_editor: EditorState, next: LayoutDocument, options: EditorOptions = {}): EditorState {
  return createEditor(next, options);
}

function sameSelection(left: EditorSnapshot, right: EditorSnapshot): boolean {
  return left.selectedId === right.selectedId && left.selectedIds.length === right.selectedIds.length
    && left.selectedIds.every((id, index) => id === right.selectedIds[index]);
}

/** Selection is normalized and frozen without changing committed history or redo. */
export function selectEditor(editor: EditorState, ids: readonly string[], primary: string | null = ids.at(-1) ?? null): EditorState {
  const selectedIds = Object.freeze(selectionIds(editor.document, ids));
  const selectedId = primary && selectedIds.includes(primary) ? primary : selectedIds[0] ?? null;
  const next = { ...editor, selectedId, selectedIds };
  return sameSelection(editor, next) ? editor : state(next);
}
