import { describe, expect, it } from 'vitest';
import { createSampleLayout, serializeLayout } from './layout';
import type { LayoutDocument } from './layout';
import {
  CLIPBOARD_LIMIT, clipBounds, clipEntry, clipPreview, clipType, emptyClipboard, forgetClip,
  mergeClipboard, parseClipboard, pasteClip, rememberClip, removeSelection, serializeClipboard,
} from './clipboard';

const meta = (id = 'clip-1') => ({ id, name: 'CPU load', copiedAt: 1_700_000_000_000 });
const empty = (width = 1280, height = 800): LayoutDocument => ({ ...createSampleLayout(), name: 'Target', canvas: { width, height }, widgets: [] });

describe('widget clipboard', () => {
  it('merges tab-only copies with incoming storage newest first and deduplicates by ID and content', () => {
    const source = createSampleLayout();
    const local = clipEntry(source, ['cpu'], { ...meta('local'), copiedAt: 10 });
    const remote = clipEntry(source, ['gpu'], { ...meta('remote'), copiedAt: 20 });
    const localBoard = rememberClip(emptyClipboard, local);
    expect(mergeClipboard(localBoard, rememberClip(emptyClipboard, remote)).entries.map((clip) => clip.id)).toEqual(['remote', 'local']);
    expect(mergeClipboard(localBoard, emptyClipboard)).toEqual(localBoard);
    const repeated = { ...local, id: 'new-local', copiedAt: 30 };
    const replacedId = { ...remote, id: 'local', copiedAt: 40 };
    expect(mergeClipboard(localBoard, rememberClip(emptyClipboard, repeated)).entries).toEqual([repeated]);
    expect(mergeClipboard(localBoard, rememberClip(emptyClipboard, replacedId)).entries).toEqual([replacedId]);
  });

  it('caps merged clipboard history at 12 without retaining older duplicates', () => {
    const source = createSampleLayout();
    const copies = Array.from({ length: 16 }, (_, index) => {
      const doc: LayoutDocument = { ...source, widgets: source.widgets.map((widget) => ({ ...widget, x: widget.x + index })) };
      return clipEntry(doc, ['cpu'], { ...meta(`clip-${index}`), copiedAt: index });
    });
    const local = copies.slice(0, 8).reduce(rememberClip, emptyClipboard);
    const stored = copies.slice(8).reduce(rememberClip, emptyClipboard);
    expect(mergeClipboard(local, stored).entries.map((clip) => clip.id)).toEqual(copies.slice(4).reverse().map((clip) => clip.id));
  });

  it('copies detached widgets in paint order with their source', () => {
    const source = createSampleLayout();
    const clip = clipEntry(source, ['weather', 'cpu'], meta());
    expect(clip.widgets.map((widget) => widget.id)).toEqual(['cpu', 'weather']);
    expect(clip).toMatchObject({ source: 'TURZX sample', canvas: { width: 1280, height: 800 }, name: 'CPU load' });
    source.widgets[0].x = 999;
    expect(clip.widgets[0].x).toBe(64);
    expect(clipType(clip)).toBe('group');
    expect(clipType(clipEntry(source, ['weather'], meta()))).toBe('weather');
    expect(() => clipEntry(source, ['missing'], meta())).toThrow('Select a card to copy.');
  });

  it('keeps the copied position when it is free in another layout', () => {
    const clip = clipEntry(createSampleLayout(), ['gpu'], meta());
    const result = pasteClip(empty(), clip);
    expect(result.placement).toBe('original');
    expect(result.ids).toEqual(['gpu']);
    expect(result.document.widgets[0]).toMatchObject({ id: 'gpu', x: 440, y: 160, width: 352, height: 224 });
    expect(result.scaled).toBe(false);
  });

  it('gives a fresh ID and the nearest free spot when the original place is taken', () => {
    const sample = createSampleLayout();
    const source = { ...sample, widgets: sample.widgets.filter((widget) => widget.id !== 'weather') };
    const result = pasteClip(source, clipEntry(source, ['cpu'], meta()));
    expect(result.placement).toBe('nearby');
    expect(result.document.widgets.at(-1)).toMatchObject({ x: 816, y: 160 });
    const pasted = result.document.widgets.at(-1)!;
    expect(pasted.id).toBe('cpu-2');
    expect(Number.isInteger(pasted.x) && Number.isInteger(pasted.y)).toBe(true);
    for (const other of source.widgets) {
      const overlap = pasted.x < other.x + other.width && pasted.x + pasted.width > other.x && pasted.y < other.y + other.height && pasted.y + pasted.height > other.y;
      expect(overlap, other.id).toBe(false);
    }
    // A second paste of the same copy picks the next suffix.
    expect(pasteClip(result.document, clipEntry(source, ['cpu'], meta())).ids).toEqual(['cpu-3']);
    expect(pasteClip(result.document, clipEntry(result.document, ['cpu-2'], meta())).ids).toEqual(['cpu-3']);
  });

  it('offsets by one gutter on a full canvas and stays inside it', () => {
    const full: LayoutDocument = { ...empty(), widgets: [{ id: 'bg', type: 'text', x: 0, y: 0, width: 1280, height: 800, settings: { label: 'Full', text: 'Full' } }] };
    const clip = clipEntry(createSampleLayout(), ['cpu'], meta());
    const result = pasteClip(full, clip);
    expect(result.placement).toBe('offset');
    expect(result.document.widgets.at(-1)).toMatchObject({ x: 88, y: 184 });
    const corner = clipEntry({ ...empty(), widgets: [{ id: 'c', type: 'text', x: 1180, y: 700, width: 100, height: 100, settings: { label: 'c', text: 'c' } }] }, ['c'], meta());
    const cornered = pasteClip({ ...full, widgets: [...full.widgets] }, corner);
    expect(cornered.document.widgets.at(-1)).toMatchObject({ x: 1156, y: 676 });
  });

  it('clamps into a smaller canvas and scales cards that are too large, keeping integers', () => {
    const source = createSampleLayout();
    const moved = pasteClip(empty(480, 480), clipEntry(source, ['cpu'], meta()));
    expect(moved.document.widgets[0]).toMatchObject({ x: 64, y: 160, width: 352, height: 224 });
    const clamped = pasteClip(empty(480, 480), clipEntry(source, ['weather'], meta()));
    // Weather is 488 px tall, so it scales to fit 480 px and keeps its aspect.
    expect(clamped.scaled).toBe(true);
    expect(clamped.document.widgets[0]).toMatchObject({ x: 87, y: 0, width: 393, height: 480 });
    const group = pasteClip(empty(400, 240), clipEntry(source, ['cpu', 'gpu', 'memory', 'weather'], meta()));
    expect(group.scaled).toBe(true);
    for (const widget of group.document.widgets) {
      expect([widget.x, widget.y, widget.width, widget.height].every(Number.isInteger)).toBe(true);
      expect(widget.x + widget.width).toBeLessThanOrEqual(400);
      expect(widget.y + widget.height).toBeLessThanOrEqual(240);
    }
    expect(serializeLayout(group.document)).toContain('"width": 400');
  });

  it('keeps the relative arrangement of a pasted group', () => {
    const source = createSampleLayout();
    const result = pasteClip(empty(), clipEntry(source, ['cpu', 'gpu'], meta()));
    const [cpu, gpu] = result.document.widgets;
    expect(gpu.x - cpu.x).toBe(376);
    expect(gpu.y - cpu.y).toBe(0);
  });

  it('remembers the newest 12 copies, moves repeated copies to the top and forgets on request', () => {
    const source = createSampleLayout();
    let board = emptyClipboard;
    for (let index = 0; index < CLIPBOARD_LIMIT + 3; index++) {
      const doc = { ...source, widgets: source.widgets.map((widget) => ({ ...widget, settings: { ...widget.settings, label: `Card ${index}` } })) } as LayoutDocument;
      board = rememberClip(board, clipEntry(doc, ['cpu'], meta(`clip-${index}`)));
    }
    expect(board.entries).toHaveLength(CLIPBOARD_LIMIT);
    expect(board.entries[0].id).toBe(`clip-${CLIPBOARD_LIMIT + 2}`);
    const again = rememberClip(board, { ...board.entries[5], id: 'clip-again' });
    expect(again.entries).toHaveLength(CLIPBOARD_LIMIT);
    expect(again.entries[0].id).toBe('clip-again');
    const label = (clip: { widgets: readonly { settings: object }[] }) => (clip.widgets[0].settings as { label?: string }).label;
    expect(again.entries.filter((clip) => label(clip) === label(board.entries[5]))).toHaveLength(1);
    expect(forgetClip(again, 'clip-again').entries.map((clip) => clip.id)).not.toContain('clip-again');
  });

  it('round-trips through storage text and drops unreadable entries individually', () => {
    const source = createSampleLayout();
    const board = rememberClip(rememberClip(emptyClipboard, clipEntry(source, ['cpu'], meta('a'))), clipEntry(source, ['gpu'], meta('b')));
    const text = serializeClipboard(board);
    expect(parseClipboard(text)).toEqual({ clipboard: board, dropped: 0 });
    const raw = JSON.parse(text);
    raw.entries.push({ ...raw.entries[0], id: 'bad-geometry', widgets: [{ ...raw.entries[0].widgets[0], x: 1.5 }] });
    raw.entries.push({ ...raw.entries[0], id: 'outside', widgets: [{ ...raw.entries[0].widgets[0], x: 1200 }] });
    raw.entries.push({ ...raw.entries[0] });
    raw.entries.push({ id: 'x', name: '', copiedAt: 0, source: '', canvas: { width: 1, height: 1 }, widgets: [] });
    raw.entries.push(null, 'text', { ...raw.entries[0], id: 'evil', canvas: { width: -1, height: 800 } });
    const parsed = parseClipboard(JSON.stringify(raw));
    expect(parsed.clipboard.entries.map((clip) => clip.id)).toEqual(['b', 'a']);
    expect(parsed.dropped).toBe(7);
    expect(parseClipboard(null)).toEqual({ clipboard: emptyClipboard, dropped: 0 });
    expect(parseClipboard('{not json')).toEqual({ clipboard: emptyClipboard, dropped: 1 });
    expect(parseClipboard('{"version":2,"entries":[]}').dropped).toBe(1);
  });

  it('builds a cropped preview document and removes several cards for cut', () => {
    const source = createSampleLayout();
    const clip = clipEntry(source, ['gpu', 'weather'], meta());
    const preview = clipPreview(clip, source.palette);
    expect(clipBounds(clip.widgets)).toEqual({ x: 440, y: 160, width: 776, height: 488 });
    expect(preview.canvas).toEqual({ width: 776, height: 488 });
    expect(preview.widgets.map((widget) => [widget.x, widget.y])).toEqual([[0, 0], [376, 0]]);
    expect(removeSelection(source, ['gpu', 'weather']).widgets.map((widget) => widget.id)).toEqual(['cpu', 'memory']);
  });
});
