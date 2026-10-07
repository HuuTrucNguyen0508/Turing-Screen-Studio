import { describe, expect, it, vi } from 'vitest';
import { createSampleLayout, moveWidget, serializeLayout } from './layout';
import {
  createRecoveryId, MAX_RECOVERY_BYTES, MAX_RECOVERY_RECORDS, parseRecovery,
  readRecovery, RECOVERY_PREFIX, recoveryKey, scanRecovery, serializeRecovery, writeRecovery,
} from './recovery';
import type { RecoveryRecord, RecoveryStorage } from './recovery';

function draft(recordId = 'tab-one'): RecoveryRecord {
  const baseline = createSampleLayout();
  return {
    version: 1, document: moveWidget(baseline, 'cpu', 15, -1), baseline: serializeLayout(baseline),
    baseRevision: 'panel-base-revision', source: 'panel', title: 'My recovered dashboard',
    time: 1791321600000, recordId,
  };
}

class MemoryStorage implements RecoveryStorage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('recovery records', () => {
  it('round trips document, baseline and metadata separately from the layout contract', () => {
    const record = draft();
    const raw = serializeRecovery(record);
    const restored = parseRecovery(raw);
    expect(restored).toEqual(record);
    expect(serializeLayout(restored.document)).toBe(serializeLayout(record.document));
    expect(serializeLayout(restored.document)).not.toBe(restored.baseline);
    expect(Object.keys(restored.document)).not.toContain('baseRevision');
    record.document.widgets[0].x++;
    expect(restored.document.widgets[0].x).toBe(79);
    expect(parseRecovery(serializeRecovery({ ...restored, baseRevision: null, source: 'file' })).baseRevision).toBeNull();
  });

  it('canonicalizes a valid compact baseline for dirty comparisons', () => {
    const record = { ...draft(), baseline: JSON.stringify(createSampleLayout()) };
    expect(parseRecovery(serializeRecovery(record)).baseline).toBe(serializeLayout(createSampleLayout()));
  });

  it.each([
    { label: 'future version', edit: { version: 3 } },
    { label: 'invalid document', edit: { document: {} } },
    { label: 'invalid baseline', edit: { baseline: '{}' } },
    { label: 'empty revision', edit: { baseRevision: '' } },
    { label: 'numeric revision', edit: { baseRevision: 2 } },
    { label: 'empty source', edit: { source: ' ' } },
    { label: 'oversized title', edit: { title: 'x'.repeat(257) } },
    { label: 'negative time', edit: { time: -1 } },
    { label: 'fractional time', edit: { time: 1.5 } },
    { label: 'invalid date', edit: { time: 8.64e15 + 1 } },
    { label: 'unsafe time', edit: { time: Number.MAX_SAFE_INTEGER + 1 } },
    { label: 'numeric ID', edit: { recordId: 1 } },
    { label: 'key traversal', edit: { recordId: '../tab' } },
    { label: 'metadata in layout', edit: { unexpected: true } },
  ])('rejects $label', ({ edit }) => {
    expect(() => parseRecovery(JSON.stringify({ ...draft(), ...edit }))).toThrow();
  });

  it('rejects missing fields, JSON syntax errors and non-object records', () => {
    for (const raw of ['{', 'null', '[]', '1']) expect(() => parseRecovery(raw)).toThrow();
    const record: Partial<RecoveryRecord> = draft();
    delete record.baseRevision;
    expect(() => parseRecovery(JSON.stringify(record))).toThrow('baseRevision');
    const hidden = draft();
    Object.defineProperty(hidden, 'extra', { value: true });
    expect(() => serializeRecovery(hidden)).toThrow('extra');
    expect(() => serializeRecovery(Object.assign(Object.create({}), draft()) as RecoveryRecord)).toThrow('plain object');
  });

  it('enforces the 1 MiB UTF-8 limit on reads and writes', () => {
    const raw = serializeRecovery(draft());
    const bytes = Buffer.byteLength(raw, 'utf8');
    expect(parseRecovery(raw + ' '.repeat(MAX_RECOVERY_BYTES - bytes))).toEqual(draft());
    expect(() => parseRecovery(raw + ' '.repeat(MAX_RECOVERY_BYTES - bytes + 1))).toThrow('1 MiB');
    const unicode = draft();
    unicode.document.name = 'é'.repeat(MAX_RECOVERY_BYTES / 2);
    const unicodeRaw = JSON.stringify(unicode);
    expect(unicodeRaw.length).toBeLessThan(MAX_RECOVERY_BYTES);
    expect(() => parseRecovery(unicodeRaw)).toThrow('1 MiB');
    expect(() => serializeRecovery(unicode)).toThrow('1 MiB');
    const astral = draft();
    astral.document.name = '🌕'.repeat(MAX_RECOVERY_BYTES / 4);
    expect(() => serializeRecovery(astral)).toThrow('1 MiB');
  });

  it('requires fresh injected IDs without using cloned session storage', () => {
    const ids = vi.fn().mockReturnValueOnce('fresh-tab-one').mockReturnValueOnce('fresh-tab-two');
    expect(createRecoveryId(ids)).toBe('fresh-tab-one');
    expect(createRecoveryId(ids)).toBe('fresh-tab-two');
    expect(ids).toHaveBeenCalledTimes(2);
    expect(() => createRecoveryId(() => '')).toThrow('recordId');
    expect(() => recoveryKey('bad:separator')).toThrow();
  });
});

describe('recovery storage', () => {
  it('writes and reads records under their own keys and leaves other tabs intact', () => {
    const storage = new MemoryStorage();
    storage.setItem('another-app', 'leave this');
    const first = draft('tab-one');
    const second = draft('tab-two');
    expect(writeRecovery(storage, first)).toEqual({ ok: true, key: recoveryKey('tab-one') });
    const original = storage.getItem(recoveryKey('tab-one'));
    expect(writeRecovery(storage, second).ok).toBe(true);
    second.document = moveWidget(second.document, 'cpu', 10, 0);
    expect(writeRecovery(storage, second).ok).toBe(true);
    expect(storage.getItem(recoveryKey('tab-one'))).toBe(original);
    expect(storage.getItem('another-app')).toBe('leave this');
    expect(readRecovery(storage, recoveryKey('tab-two'))).toMatchObject({ status: 'valid', record: second });
    expect(readRecovery(storage, recoveryKey('missing'))).toBeNull();
  });

  it('scans newest first and preserves malformed, mismatched and oversized records for export', () => {
    const storage = new MemoryStorage();
    const first = draft('older');
    const second = { ...draft('newer'), time: first.time + 1 };
    writeRecovery(storage, first);
    writeRecovery(storage, second);
    storage.setItem(recoveryKey('broken'), '{bad JSON');
    storage.setItem(recoveryKey('mismatch'), serializeRecovery(draft('different-id')));
    storage.setItem(recoveryKey('oversized'), 'x'.repeat(MAX_RECOVERY_BYTES + 1));
    storage.setItem('another-app', 'unrelated');
    const before = [...storage.values];
    const result = scanRecovery(storage);
    expect(result.entries.slice(0, 2).map((entry) => entry.key)).toEqual([recoveryKey('newer'), recoveryKey('older')]);
    expect(result.entries).toContainEqual({ key: recoveryKey('broken'), status: 'corrupt', raw: '{bad JSON', error: 'Recovery record contains invalid JSON.' });
    expect(result.entries.find((entry) => entry.key === recoveryKey('mismatch'))).toMatchObject({ status: 'corrupt', error: 'Recovery record ID does not match its storage key.' });
    expect(result.entries.find((entry) => entry.key === recoveryKey('oversized'))).toMatchObject({ status: 'corrupt', raw: null });
    expect(result.errors).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect([...storage.values]).toEqual(before);
    expect(writeRecovery(storage, draft('new-tab')).ok).toBe(true);
    expect(storage.getItem(recoveryKey('oversized'))).toBe(before.find(([key]) => key === recoveryKey('oversized'))?.[1]);
  });

  it('refuses to replace corrupt records or mismatched IDs', () => {
    const storage = new MemoryStorage();
    storage.setItem(recoveryKey('tab-one'), 'corrupt but exportable');
    const failed = writeRecovery(storage, draft());
    expect(failed).toMatchObject({ ok: false, key: recoveryKey('tab-one') });
    expect(storage.getItem(recoveryKey('tab-one'))).toBe('corrupt but exportable');
    storage.setItem(recoveryKey('tab-one'), serializeRecovery(draft('another-tab')));
    expect(writeRecovery(storage, draft()).ok).toBe(false);
    expect(parseRecovery(storage.getItem(recoveryKey('tab-one'))!).recordId).toBe('another-tab');
  });

  it('preserves the last good record on invalid edits and quota errors', () => {
    const storage = new MemoryStorage();
    const record = draft();
    writeRecovery(storage, record);
    const lastGood = storage.getItem(recoveryKey(record.recordId));
    const bad = { ...record, document: { ...record.document, name: '' } };
    expect(writeRecovery(storage, bad).ok).toBe(false);
    expect(storage.getItem(recoveryKey(record.recordId))).toBe(lastGood);
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    const changed = { ...record, document: moveWidget(record.document, 'cpu', 2, 0) };
    expect(writeRecovery(storage, changed)).toMatchObject({ ok: false, error: 'Quota exceeded' });
    expect(storage.getItem(recoveryKey(record.recordId))).toBe(lastGood);
    expect(parseRecovery(lastGood!).document).toEqual(record.document);
  });

  it('reports inaccessible storage without throwing or attempting writes', () => {
    const storage = new MemoryStorage();
    const set = vi.spyOn(storage, 'setItem');
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    expect(readRecovery(storage, recoveryKey('tab-one'))).toMatchObject({ status: 'corrupt', raw: null, error: 'Storage blocked' });
    expect(writeRecovery(storage, draft())).toMatchObject({ ok: false });
    expect(set).not.toHaveBeenCalled();
    vi.spyOn(storage, 'length', 'get').mockImplementation(() => { throw new Error('Length blocked'); });
    expect(scanRecovery(storage)).toEqual({ entries: [], errors: ['Length blocked'], truncated: false });
  });

  it('keeps partial scan results and reports a key enumeration error', () => {
    const storage = new MemoryStorage();
    writeRecovery(storage, draft());
    storage.setItem('unrelated', 'value');
    const key = storage.key.bind(storage);
    vi.spyOn(storage, 'key').mockImplementation((index) => {
      if (index === 1) throw new Error('Key blocked');
      return key(index);
    });
    const scan = scanRecovery(storage);
    expect(scan.entries).toHaveLength(1);
    expect(scan.errors).toEqual(['Key blocked']);
    expect(writeRecovery(storage, draft('new-tab')).ok).toBe(false);
    expect(storage.getItem(recoveryKey('new-tab'))).toBeNull();
  });

  it('bounds recovery record counts and refuses new records without evicting older ones', () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < MAX_RECOVERY_RECORDS; i++) {
      storage.setItem(recoveryKey(`tab-${i}`), serializeRecovery(draft(`tab-${i}`)));
    }
    const before = [...storage.values];
    expect(writeRecovery(storage, draft('new-tab'))).toMatchObject({ ok: false });
    expect([...storage.values]).toEqual(before);
    expect(writeRecovery(storage, { ...draft('tab-0'), time: 1 }).ok).toBe(true);
    storage.setItem(recoveryKey('extra-tab'), 'corrupt');
    expect(scanRecovery(storage)).toMatchObject({ truncated: true });
    expect(scanRecovery(storage).entries).toHaveLength(MAX_RECOVERY_RECORDS);
    expect(storage.getItem(recoveryKey('extra-tab'))).toBe('corrupt');
  });

  it('bounds key enumeration even when another app has thousands of entries', () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < 4100; i++) storage.setItem(`other-${i}`, 'value');
    const key = vi.spyOn(storage, 'key');
    expect(scanRecovery(storage)).toEqual({ entries: [], errors: [], truncated: true });
    expect(key).toHaveBeenCalledTimes(4096);
    expect(writeRecovery(storage, draft()).ok).toBe(false);
    expect(storage.getItem(recoveryKey('tab-one'))).toBeNull();
  });

  it('supports explicit prefixes and rejects empty prefixes', () => {
    const storage = new MemoryStorage();
    expect(writeRecovery(storage, draft(), 'test-drafts:').ok).toBe(true);
    expect(scanRecovery(storage).entries).toHaveLength(0);
    expect(scanRecovery(storage, 'test-drafts:').entries).toHaveLength(1);
    expect(readRecovery(storage, `${RECOVERY_PREFIX}outside`, 'test-drafts:')).toMatchObject({ status: 'corrupt' });
    expect(writeRecovery(storage, draft(), '')).toMatchObject({ ok: false });
    expect(scanRecovery(storage, '').errors).toHaveLength(1);
  });
});


describe('draft targets', () => {
  it('roundtrips a version 2 library target while retaining version 1 compatibility', () => {
    const legacy = draft();
    const target = { kind: 'library' as const, entryId: 'focus', entryName: 'Focus', libraryRevision: 'lib-1', entryText: legacy.baseline };
    expect(parseRecovery(serializeRecovery({ ...legacy, version: 2, target })).target).toEqual(target);
    expect(parseRecovery(serializeRecovery(legacy)).target).toBeUndefined();
    expect(() => serializeRecovery({ ...legacy, version: 2 })).toThrow();
  });
});
