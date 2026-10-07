import { parseLayout, serializeLayout } from './layout';
import type { LayoutDocument } from './layout';

export type Entry = { id: string; name: string; document: LayoutDocument };
export type Library = { entries: Entry[]; revision: string; activeId: string | null };
export type LibraryDraftTarget = {
  kind: 'library'; entryId: string; entryName: string; libraryRevision: string; entryText: string;
};

export function parseLibrary(raw: unknown): Library {
  if (!raw || typeof raw !== 'object' || !('entries' in raw) || !Array.isArray(raw.entries)
    || raw.entries.length > 12 || !('revision' in raw) || typeof raw.revision !== 'string' || !raw.revision
    || !('activeId' in raw) || (raw.activeId !== null && typeof raw.activeId !== 'string')) {
    throw new Error('Library could not be read.');
  }
  const ids = new Set<string>();
  const entries = raw.entries.map((entry: unknown): Entry => {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.id) || ids.has(entry.id)
      || !('name' in entry) || typeof entry.name !== 'string' || !entry.name.trim()
      || entry.name.length > 120 || !('document' in entry)) throw new Error('Invalid library entry.');
    ids.add(entry.id);
    return { id: entry.id, name: entry.name, document: parseLayout(JSON.stringify(entry.document)) };
  });
  return { entries, revision: raw.revision, activeId: raw.activeId };
}

export function libraryTarget(entry: Entry, libraryRevision: string): LibraryDraftTarget {
  return { kind: 'library', entryId: entry.id, entryName: entry.name, libraryRevision,
    entryText: serializeLayout(entry.document) };
}

export function duplicateEntry(entry: Entry, entries: Entry[], id: string): Entry {
  const names = new Set(entries.flatMap((saved) => [saved.name, saved.document.name]));
  let suffix = ' copy';
  let name = `${entry.name.slice(0, 120 - suffix.length)}${suffix}`;
  for (let count = 2; names.has(name); count++) {
    suffix = ` copy ${count}`;
    name = `${entry.name.slice(0, 120 - suffix.length)}${suffix}`;
  }
  const document = parseLayout(serializeLayout(entry.document));
  document.name = name;
  return { id, name, document };
}

export type Archive = { id: string; name: string; revision: string; createdAt: string; reason: string };
export type ArchiveGroup = { revision: string; copies: Archive[] };

export function parseArchives(raw: unknown): Archive[] {
  if (!raw || typeof raw !== 'object' || !('archives' in raw) || !Array.isArray(raw.archives)) {
    throw new Error('History could not be read.');
  }
  const ids = new Set<string>();
  return raw.archives.map((archive: unknown): Archive => {
    if (!archive || typeof archive !== 'object' || !('id' in archive) || typeof archive.id !== 'string'
      || !/^[A-Za-z0-9_-]+$/.test(archive.id) || ids.has(archive.id)
      || !('name' in archive) || typeof archive.name !== 'string' || !archive.name.trim()
      || !('revision' in archive) || typeof archive.revision !== 'string' || !archive.revision
      || !('createdAt' in archive) || typeof archive.createdAt !== 'string'
      || !Number.isFinite(Date.parse(archive.createdAt))
      || !('reason' in archive) || typeof archive.reason !== 'string' || !archive.reason) {
      throw new Error('Invalid history entry. Refresh History to try again.');
    }
    ids.add(archive.id);
    return { id: archive.id, name: archive.name, revision: archive.revision,
      createdAt: archive.createdAt, reason: archive.reason };
  });
}

export function groupArchives(archives: Archive[]): ArchiveGroup[] {
  const groups = new Map<string, ArchiveGroup>();
  for (const archive of [...archives].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    let group = groups.get(archive.revision);
    if (!group) { group = { revision: archive.revision, copies: [] }; groups.set(archive.revision, group); }
    group.copies.push(archive);
  }
  return [...groups.values()];
}
