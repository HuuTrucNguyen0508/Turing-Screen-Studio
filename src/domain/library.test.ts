import { describe, expect, it } from 'vitest';
import { createSampleLayout, serializeLayout } from './layout';
import { duplicateEntry, groupArchives, libraryTarget, parseArchives, parseLibrary } from './library';
import type { Archive, Entry } from './library';

function entry(name = 'Focus', id = 'focus'): Entry {
  return { id, name, document: { ...createSampleLayout(), name } };
}

function archive(id: string, revision: string, createdAt: string): Archive {
  return { id, revision, createdAt, name: 'Older dashboard', reason: 'panel-save' };
}

describe('library editing contract', () => {
  it('reads detached documents and preserves the whole-list revision and active entry', () => {
    const raw = { entries: [entry()], revision: 'library-1', activeId: 'focus' };
    const library = parseLibrary(raw);
    expect(library).toEqual(raw);
    library.entries[0].document.widgets[0].x++;
    expect(raw.entries[0].document.widgets[0].x).toBe(64);
  });

  it('uses serialized document text as the edit baseline instead of assuming a server hash', () => {
    const saved = entry();
    expect(libraryTarget(saved, 'library-1')).toEqual({ kind: 'library', entryId: 'focus', entryName: 'Focus',
      libraryRevision: 'library-1', entryText: serializeLayout(saved.document) });
    const renamed = { ...saved, name: 'Desk' };
    expect(libraryTarget(renamed, 'library-2').entryText).toBe(libraryTarget(saved, 'library-1').entryText);
  });

  it('duplicates with a unique document name and preserves the source document', () => {
    const saved = entry();
    const copy = duplicateEntry(saved, [saved, entry('Focus copy', 'copy'), entry('Focus copy 2', 'copy-2')], 'new-copy');
    expect(copy.name).toBe('Focus copy 3');
    expect(copy.document.name).toBe('Focus copy 3');
    expect(copy.id).toBe('new-copy');
    expect(copy.document.widgets).toEqual(saved.document.widgets);
    copy.document.widgets[0].x++;
    expect(saved.document.widgets[0].x).toBe(64);
    expect(saved.document.name).toBe('Focus');
  });

  it('keeps duplicate names within the server limit, including numbered copies', () => {
    const saved = entry('a'.repeat(120));
    const first = duplicateEntry(saved, [saved], 'first-copy');
    const second = duplicateEntry(saved, [saved, first], 'second-copy');
    expect(first.name).toHaveLength(120);
    expect(second.name).toHaveLength(120);
    expect(second.name.endsWith(' copy 2')).toBe(true);
    expect(second.document.name).toBe(second.name);
  });

  it.each([
    { entries: [entry(), entry('Other')], revision: 'r', activeId: null },
    { entries: [entry(' ', 'blank')], revision: 'r', activeId: null },
    { entries: [entry('Focus', '../focus')], revision: 'r', activeId: null },
    { entries: Array.from({ length: 13 }, (_, index) => entry(`Name ${index}`, `entry-${index}`)), revision: 'r', activeId: null },
    { entries: [entry()], revision: '', activeId: null },
    { entries: [entry()], revision: 'r', activeId: 1 },
  ])('rejects malformed library metadata', (raw) => {
    expect(() => parseLibrary(raw)).toThrow();
  });

  it('rejects invalid documents before offering them for editing', () => {
    const saved = entry(); saved.document.widgets[0].x = 1.5;
    expect(() => parseLibrary({ entries: [saved], revision: 'r', activeId: null })).toThrow();
  });
});

describe('archive presentation', () => {
  it('groups newest first while retaining every archive ID, time and reason', () => {
    const oldest = archive('archive-a', 'same', '2026-10-06T19:00:00Z');
    const latest = archive('archive-c', 'same', '2026-10-06T21:00:00Z');
    const middle = archive('archive-b', 'other', '2026-10-06T20:00:00Z');
    middle.reason = 'saved-layout-list-change';
    const source = [oldest, middle, latest];
    const groups = groupArchives(parseArchives({ archives: source }));
    expect(groups.map((group) => group.revision)).toEqual(['same', 'other']);
    expect(groups[0].copies).toEqual([latest, oldest]);
    expect(groups[1].copies).toEqual([middle]);
    expect(source).toEqual([oldest, middle, latest]);
    expect(groups.flatMap((group) => group.copies.map((copy) => copy.id)).sort()).toEqual(['archive-a', 'archive-b', 'archive-c']);
  });

  it('does not collapse timestamps or different revisions with the same name', () => {
    const groups = groupArchives([
      archive('a', 'one', '2026-10-06T20:00:00Z'),
      archive('b', 'two', '2026-10-06T20:00:00Z'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it.each([
    { archives: [archive('../bad', 'r', '2026-10-06T20:00:00Z')] },
    { archives: [archive('a', 'r', 'not-a-date')] },
    { archives: [archive('a', '', '2026-10-06T20:00:00Z')] },
    { archives: [archive('a', 'r', '2026-10-06T20:00:00Z'), archive('a', 'r', '2026-10-06T21:00:00Z')] },
    { archives: null },
  ])('rejects malformed history metadata', (raw) => {
    expect(() => parseArchives(raw)).toThrow();
  });
});
