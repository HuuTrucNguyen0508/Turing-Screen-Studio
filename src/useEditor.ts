import { useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import { beginGesture, commitEdit, createEditor, finishGesture, previewGesture, redoEdit, replaceEditor, selectEditor, undoEdit } from './domain/editor';
import { parseDraftTarget } from './domain/draft';
import type { DraftTarget } from './domain/draft';
import type { EditorOptions, EditorState } from './domain/editor';
import { createSampleLayout, serializeLayout } from './domain/layout';
import type { LayoutDocument } from './domain/layout';

export default function useEditor() {
  const [state, setState] = useState(() => createEditor(createSampleLayout()));
  const current = useRef(state);
  function update(next: EditorState) { current.current = next; setState(next); }
  function change(value: SetStateAction<LayoutDocument>, selectedId?: string | null) {
    const editor = current.current;
    const next = typeof value === 'function' ? value(editor.document) : value;
    update(editor.gesture ? previewGesture(editor, next, selectedId) : commitEdit(editor, next, selectedId));
  }
  return {
    state, current, change,
    select(id: string | null, toggle = false, preserve = false) {
      const editor = current.current;
      if (preserve && id && editor.selectedIds.includes(id)) { update(selectEditor(editor, editor.selectedIds, id)); return; }
      const ids = toggle && id ? editor.selectedIds.includes(id) ? editor.selectedIds.filter((entry) => entry !== id) : [...editor.selectedIds, id] : id ? [id] : [];
      update(selectEditor(editor, ids, id));
    },
    selectAll() { update(selectEditor(current.current, current.current.document.widgets.map((widget) => widget.id), current.current.selectedId)); },
    replace(document: LayoutDocument, options?: EditorOptions) { update(replaceEditor(current.current, document, options)); },
    saved(document: LayoutDocument, revision: string | null, target?: DraftTarget) { update({ ...current.current, baseline: serializeLayout(document), baseRevision: revision, target: target ?? current.current.target }); },
    target(target: DraftTarget) { update({ ...current.current, target: Object.freeze(parseDraftTarget(target)) }); },
    revision(revision: string | null) { update({ ...current.current, baseRevision: revision }); },
    begin() { update(beginGesture(current.current)); },
    finish(cancel: boolean) { update(finishGesture(current.current, cancel)); },
    undo() { update(undoEdit(current.current)); },
    redo() { update(redoEdit(current.current)); },
  };
}
