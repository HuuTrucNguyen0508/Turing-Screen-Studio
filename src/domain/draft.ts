import { parseLayout, serializeLayout } from './layout';

export type DraftTarget = { kind: 'local' } | { kind: 'panel' }
  | { kind: 'library'; entryId: string; entryName: string; libraryRevision: string; entryText: string }
  | { kind: 'archive'; archiveId: string; createdAt: string };

export function parseDraftTarget(raw: unknown): DraftTarget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Draft target must be an object.');
  const value = raw as Record<string, unknown>;
  const fields = value.kind === 'library' ? ['kind', 'entryId', 'entryName', 'libraryRevision', 'entryText']
    : value.kind === 'archive' ? ['kind', 'archiveId', 'createdAt'] : ['kind'];
  if (Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))) throw new Error('Draft target contains invalid fields.');
  const string = (key: string, max = 256) => {
    const text = value[key];
    if (typeof text !== 'string' || !text.trim() || text.length > max) throw new Error(`Draft target ${key} is invalid.`);
    return text;
  };
  if (value.kind === 'local' || value.kind === 'panel') return { kind: value.kind };
  if (value.kind === 'library') return { kind: 'library', entryId: string('entryId', 64), entryName: string('entryName', 120), libraryRevision: string('libraryRevision'), entryText: serializeLayout(parseLayout(string('entryText', 1024 * 1024))) };
  if (value.kind === 'archive') return { kind: 'archive', archiveId: string('archiveId'), createdAt: string('createdAt') };
  throw new Error('Unsupported draft target.');
}
