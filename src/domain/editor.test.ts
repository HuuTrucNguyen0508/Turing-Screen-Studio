import { describe, expect, it } from 'vitest';
import { createSampleLayout, moveWidget, serializeLayout } from './layout';
import { moveSelection } from './canvas';
import type { LayoutDocument } from './layout';
import {
  beginGesture, commitEdit, createEditor, editorDirty, finishGesture,
  previewGesture, redoEdit, replaceEditor, selectEditor, undoEdit,
} from './editor';

describe('editor history', () => {
  it('detaches and protects exact snapshots from later input mutation', () => {
    const document = createSampleLayout();
    const original = serializeLayout(document);
    const editor = createEditor(document, { selectedId: 'cpu', baseRevision: 'panel-1' });
    document.widgets[0].x++;
    document.palette.primary = '#ffffff';
    expect(serializeLayout(editor.document)).toBe(original);
    expect(editor).toMatchObject({ selectedId: 'cpu', baseRevision: 'panel-1', past: [], future: [], gesture: null });
    expect(() => { editor.document.widgets[0].x++; }).toThrow();
    expect(editorDirty(editor)).toBe(false);
  });

  it('undoes and redoes geometry, settings and palette without losing selection', () => {
    const original = createEditor(createSampleLayout(), { selectedId: 'weather' });
    const editedDocument: LayoutDocument = {
      ...moveWidget(original.document, 'cpu', 17, 23),
      name: 'Edited', paletteMode: 'saved',
      palette: { ...original.document.palette, primary: '#ffffff' },
    };
    editedDocument.widgets = editedDocument.widgets.map((widget) => widget.type === 'metric'
      ? { ...widget, settings: { ...widget.settings, label: 'A changed label', source: 'cpu' } }
      : widget);
    const changed = commitEdit(original, editedDocument, 'cpu');
    expect(editorDirty(changed)).toBe(true);
    const undone = undoEdit(changed);
    expect(serializeLayout(undone.document)).toBe(serializeLayout(original.document));
    expect(undone.selectedId).toBe('weather');
    expect(editorDirty(undone)).toBe(false);
    const redone = redoEdit(undone);
    expect(serializeLayout(redone.document)).toBe(serializeLayout(editedDocument));
    expect(redone.selectedId).toBe('cpu');
    expect(editorDirty(redone)).toBe(true);
  });

  it('restores a deleted widget and its selection and never keeps a missing selection', () => {
    const original = createEditor(createSampleLayout(), { selectedId: 'cpu' });
    const removed = commitEdit(original, { ...original.document, widgets: original.document.widgets.slice(1) });
    expect(removed.selectedId).toBeNull();
    expect(undoEdit(removed).selectedId).toBe('cpu');
    expect(redoEdit(undoEdit(removed)).selectedId).toBeNull();
    expect(createEditor(original.document, { selectedId: 'missing' }).selectedId).toBeNull();
    expect(createEditor({ ...original.document, widgets: [] }).selectedId).toBeNull();
    expect(createEditor(original.document, { selectedId: null }).selectedId).toBeNull();
  });

  it('preserves redo on no-op and selection-only updates, then discards it on a new edit', () => {
    const original = createEditor(createSampleLayout());
    const changed = commitEdit(original, moveWidget(original.document, 'cpu', 1, 0));
    const undone = undoEdit(changed);
    expect(commitEdit(undone, createSampleLayout())).toBe(undone);
    const selected = commitEdit(undone, undone.document, 'weather');
    expect(selected.past).toHaveLength(0);
    expect(selected.future).toHaveLength(1);
    expect(selected.selectedId).toBe('weather');
    const branched = commitEdit(selected, moveWidget(selected.document, 'weather', -10, 0));
    expect(branched.future).toHaveLength(0);
    expect(redoEdit(branched)).toBe(branched);
    expect(undoEdit(branched).selectedId).toBe('weather');
  });

  it('rejects invalid commits without altering the document or redo branch', () => {
    const original = createEditor(createSampleLayout());
    const undone = undoEdit(commitEdit(original, moveWidget(original.document, 'cpu', 1, 0)));
    const bad = { ...undone.document, version: 2 } as unknown as LayoutDocument;
    expect(() => commitEdit(undone, bad)).toThrow('$.version');
    expect(undone.past).toHaveLength(0);
    expect(undone.future).toHaveLength(1);
    expect(serializeLayout(redoEdit(undone).document)).toBe(serializeLayout(moveWidget(original.document, 'cpu', 1, 0)));
  });

  it('keeps the current save baseline and revision when undoing past the saved document', () => {
    const original = createEditor(createSampleLayout(), { baseRevision: 'first' });
    const changed = commitEdit(original, moveWidget(original.document, 'cpu', 1, 0));
    const saved = { ...changed, baseline: serializeLayout(changed.document), baseRevision: 'second' };
    expect(editorDirty(saved)).toBe(false);
    const undone = undoEdit(saved);
    expect(editorDirty(undone)).toBe(true);
    expect(undone.baseRevision).toBe('second');
    expect(undone.baseline).toBe(saved.baseline);
    expect(editorDirty(redoEdit(undone))).toBe(false);
  });

  it('limits history to 100 edits with correct undo and redo order', () => {
    let editor = createEditor(createSampleLayout());
    for (let i = 1; i <= 125; i++) editor = commitEdit(editor, { ...editor.document, name: `Edit ${i}` });
    expect(editor.past).toHaveLength(100);
    for (let i = 0; i < 100; i++) editor = undoEdit(editor);
    expect(editor.document.name).toBe('Edit 25');
    expect(undoEdit(editor)).toBe(editor);
    expect(editor.future).toHaveLength(100);
    for (let i = 0; i < 100; i++) editor = redoEdit(editor);
    expect(editor.document.name).toBe('Edit 125');
    expect(redoEdit(editor)).toBe(editor);
  });

  it('replaces the editor with fresh history and supports a recovered dirty baseline', () => {
    const original = createEditor(createSampleLayout());
    const changed = commitEdit(original, moveWidget(original.document, 'cpu', 1, 0));
    const opened = replaceEditor(changed, changed.document, { selectedId: 'weather', baseRevision: 'opened' });
    expect(opened).toMatchObject({ past: [], future: [], gesture: null, selectedId: 'weather', baseRevision: 'opened' });
    expect(editorDirty(opened)).toBe(false);
    const recovered = replaceEditor(opened, changed.document, { baseline: original.baseline, baseRevision: 'original' });
    expect(editorDirty(recovered)).toBe(true);
    expect(() => replaceEditor(opened, opened.document, { baseline: '{}' })).toThrow();
    expect(() => createEditor(opened.document, { baseRevision: '' })).toThrow();
    expect(opened.document).toEqual(changed.document);
  });
});

describe('editor gestures', () => {
  it('coalesces pointer frames into one undo step and keeps the initial selection', () => {
    const original = createEditor(createSampleLayout(), { selectedId: 'weather' });
    let editor = beginGesture(original);
    for (let i = 1; i <= 30; i++) {
      editor = previewGesture(editor, moveWidget(original.document, 'cpu', i, i), 'cpu');
      expect(editor.past).toHaveLength(0);
    }
    editor = finishGesture(editor);
    expect(editor.past).toHaveLength(1);
    expect(editor.gesture).toBeNull();
    const undone = undoEdit(editor);
    expect(undone.document).toEqual(original.document);
    expect(undone.selectedId).toBe('weather');
    expect(redoEdit(undone).document).toEqual(moveWidget(original.document, 'cpu', 30, 30));
  });

  it('cancels document and selection while retaining a redo branch and saved metadata', () => {
    const original = createEditor(createSampleLayout(), { selectedId: 'weather', baseRevision: 'panel' });
    const undone = undoEdit(commitEdit(original, moveWidget(original.document, 'cpu', 1, 0)));
    const gesture = previewGesture(beginGesture(undone), moveWidget(undone.document, 'cpu', 20, 20), 'cpu');
    const cancelled = finishGesture(gesture, true);
    expect(cancelled.document).toEqual(undone.document);
    expect(cancelled.selectedId).toBe('weather');
    expect(cancelled.past).toEqual(undone.past);
    expect(cancelled.future).toEqual(undone.future);
    expect(cancelled.baseRevision).toBe('panel');
    expect(editorDirty(cancelled)).toBe(false);
  });

  it('adds no history when a drag returns to its origin or changes selection alone', () => {
    const original = createEditor(createSampleLayout());
    const undone = undoEdit(commitEdit(original, moveWidget(original.document, 'cpu', 1, 0)));
    let gesture = previewGesture(beginGesture(undone), moveWidget(undone.document, 'cpu', 10, 0));
    gesture = previewGesture(gesture, undone.document, 'weather');
    const finished = finishGesture(gesture);
    expect(finished.past).toHaveLength(0);
    expect(finished.future).toHaveLength(1);
    expect(finished.selectedId).toBe('weather');
    expect(finishGesture(finished)).toBe(finished);
    expect(undoEdit(original)).toBe(original);
    expect(redoEdit(original)).toBe(original);
  });

  it('preserves the initial transaction on repeated begin and commits a final document once', () => {
    const original = createEditor(createSampleLayout());
    const gesture = previewGesture(beginGesture(original), moveWidget(original.document, 'cpu', 5, 0));
    expect(beginGesture(gesture)).toBe(gesture);
    const committed = commitEdit(gesture, moveWidget(original.document, 'cpu', 10, 0));
    expect(committed.past).toHaveLength(1);
    expect(committed.gesture).toBeNull();
    expect(undoEdit(committed).document).toEqual(original.document);
  });

  it('rejects invalid previews without losing a cancellable transaction', () => {
    const original = createEditor(createSampleLayout());
    expect(() => previewGesture(original, original.document)).toThrow('Begin');
    const gesture = previewGesture(beginGesture(original), moveWidget(original.document, 'cpu', 5, 0));
    const bad = { ...gesture.document, name: '' };
    expect(() => previewGesture(gesture, bad)).toThrow('$.name');
    expect(finishGesture(gesture, true).document).toEqual(original.document);
    expect(gesture.past).toHaveLength(0);
  });

  it('cancels an active gesture before undoing or redoing committed edits', () => {
    const original = createEditor(createSampleLayout());
    const changed = commitEdit(original, moveWidget(original.document, 'cpu', 1, 0));
    const gesture = previewGesture(beginGesture(changed), moveWidget(original.document, 'cpu', 5, 0));
    const undone = undoEdit(gesture);
    expect(undone.document).toEqual(original.document);
    expect(undone.future).toHaveLength(1);
    const redoGesture = previewGesture(beginGesture(undone), moveWidget(original.document, 'cpu', 9, 0));
    expect(redoEdit(redoGesture).document).toEqual(changed.document);
  });
});

describe('editor multi-selection', () => {
  it('normalizes and freezes selections in state and history while keeping a primary', () => {
    const ids = ['weather', 'gpu', 'gpu', 'missing'];
    const editor = createEditor(createSampleLayout(), { selectedId: 'weather', selectedIds: ids });
    ids.push('cpu');
    expect(editor.selectedIds).toEqual(['gpu', 'weather']);
    expect(editor.selectedId).toBe('weather');
    expect(Object.isFrozen(editor.selectedIds)).toBe(true);
    expect(() => (editor.selectedIds as string[]).push('cpu')).toThrow();
    const changed = commitEdit(editor, moveSelection(editor.document, editor.selectedIds, 5, 7));
    expect(changed.past[0].selectedIds).toEqual(editor.selectedIds);
    expect(Object.isFrozen(changed.past[0].selectedIds)).toBe(true);
    expect(undoEdit(changed).selectedIds).toEqual(editor.selectedIds);
    expect(redoEdit(undoEdit(changed)).selectedId).toBe('weather');
  });

  it('changes only selection without history or discarding redo, and handles removal', () => {
    const initial = createEditor(createSampleLayout());
    const undone = undoEdit(commitEdit(initial, moveWidget(initial.document, 'cpu', 1, 0)));
    const selected = selectEditor(undone, ['gpu', 'cpu', 'missing', 'gpu'], 'gpu');
    expect(selected.selectedIds).toEqual(['cpu', 'gpu']);
    expect(selected.selectedId).toBe('gpu');
    expect(selected.past).toBe(undone.past);
    expect(selected.future).toBe(undone.future);
    expect(editorDirty(selected)).toBe(false);
    expect(selectEditor(selected, ['cpu', 'gpu'], 'gpu')).toBe(selected);
    const removed = commitEdit(selected, { ...selected.document, widgets: selected.document.widgets.filter((widget) => widget.id !== 'gpu') });
    expect(removed.selectedIds).toEqual(['cpu']);
    expect(removed.selectedId).toBe('cpu');
    expect(undoEdit(removed).selectedIds).toEqual(['cpu', 'gpu']);
    expect(selectEditor(selected, []).selectedId).toBeNull();
    expect(commitEdit(selected, selected.document, 'weather').selectedIds).toEqual(['weather']);
  });

  it('coalesces a clamped group drag, preserving geometry and restoring the complete selection', () => {
    const initial = createEditor(createSampleLayout(), { selectedId: 'gpu', selectedIds: ['cpu', 'gpu'] });
    let editor = beginGesture(initial);
    for (const distance of [10, 100, 2000]) editor = previewGesture(editor, moveSelection(initial.document, initial.selectedIds, distance, distance));
    expect(editor.past).toHaveLength(0);
    const before = initial.document.widgets;
    const after = editor.document.widgets;
    expect(after[1].x - after[0].x).toBe(before[1].x - before[0].x);
    expect(after[1].y - after[0].y).toBe(before[1].y - before[0].y);
    expect(finishGesture(editor, true).document).toEqual(initial.document);
    expect(finishGesture(editor, true).selectedIds).toEqual(initial.selectedIds);
    const committed = finishGesture(editor);
    expect(committed.past).toHaveLength(1);
    const undone = undoEdit(selectEditor(committed, ['weather']));
    expect(undone.document).toEqual(initial.document);
    expect(undone.selectedIds).toEqual(['cpu', 'gpu']);
    expect(undone.selectedId).toBe('gpu');
    expect(redoEdit(undone).document).toEqual(committed.document);
  });
});
