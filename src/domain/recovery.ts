import { parseLayout, serializeLayout, validateLayout } from './layout';
import type { LayoutDocument } from './layout';
import { parseDraftTarget } from './draft';
import type { DraftTarget } from './draft';

export const RECOVERY_PREFIX = 'turzx-studio:recovery:v1:';
export const MAX_RECOVERY_BYTES = 1024 * 1024;
export const MAX_RECOVERY_RECORDS = 100;
const MAX_STORAGE_KEYS = 4096;

export interface RecoveryRecord {
  version: 1 | 2;
  target?: DraftTarget;
  document: LayoutDocument;
  baseline: string;
  baseRevision: string | null;
  source: string;
  title: string;
  /** Milliseconds since the Unix epoch. */
  time: number;
  recordId: string;
}

/** Web Storage satisfies this interface. setItem must be atomic on failure. */
export interface RecoveryStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type RecoveryEntry =
  | { key: string; status: 'valid'; raw: string; record: RecoveryRecord }
  | { key: string; status: 'corrupt'; raw: string | null; error: string; unavailable?: boolean };

export interface RecoveryScan {
  entries: RecoveryEntry[];
  errors: string[];
  /** More keys or records exist than the bounded scan can inspect. Nothing is removed. */
  truncated: boolean;
}

export type RecoveryWrite = { ok: true; key: string } | { ok: false; key: string | null; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`Recovery ${field} must be a nonempty string of at most ${limit} characters.`);
  }
  return value;
}

function identifier(value: unknown): string {
  const id = text(value, 'recordId', 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Recovery recordId contains unsupported characters.');
  return id;
}

/** Inject crypto.randomUUID and call once per page instance. Never reuse a sessionStorage ID. */
export function createRecoveryId(makeId: () => string): string {
  return identifier(makeId());
}

export function recoveryKey(recordId: string, prefix = RECOVERY_PREFIX): string {
  if (!prefix || prefix.length > 256) throw new Error('Recovery prefix must contain 1 to 256 characters.');
  return `${prefix}${identifier(recordId)}`;
}

// UTF-8 length without browser or Node types, including replacement of unpaired surrogates.
function checkSize(value: string): void {
  let bytes = 0;
  if (value.length <= MAX_RECOVERY_BYTES) {
    for (let i = 0; i < value.length; i++) {
      const point = value.codePointAt(i)!;
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (point > 0xffff) i++;
      if (bytes > MAX_RECOVERY_BYTES) break;
    }
    if (bytes <= MAX_RECOVERY_BYTES) return;
  }
  throw new Error('Recovery record exceeds the 1 MiB limit.');
}

function validateRecord(input: unknown): RecoveryRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new Error('Recovery record must be a plain object.');
  }
  const value = input as Record<string, unknown>;
  const fields = ['version', 'document', 'baseline', 'baseRevision', 'source', 'title', 'time', 'recordId'];
  if (value.version === 2) fields.push('target');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) throw new Error(`Recovery record has an unexpected field: ${String(key)}.`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new Error(`Recovery ${field} is missing.`);
  }
  if (value.version !== 1 && value.version !== 2) throw new Error('Unsupported recovery version; expected 1 or 2.');
  const document = validateLayout(value.document);
  const baselineText = text(value.baseline, 'baseline', MAX_RECOVERY_BYTES);
  checkSize(baselineText);
  const baseline = serializeLayout(parseLayout(baselineText));
  const baseRevision = value.baseRevision === null ? null : text(value.baseRevision, 'baseRevision', 256);
  const source = text(value.source, 'source', 256);
  const title = text(value.title, 'title', 256);
  const recordId = identifier(value.recordId);
  if (typeof value.time !== 'number' || !Number.isSafeInteger(value.time) || value.time < 0 || value.time > 8.64e15) {
    throw new Error('Recovery time must be a valid nonnegative integer timestamp in milliseconds.');
  }
  return { version: value.version, document, baseline, baseRevision, source, title, time: value.time, recordId,
    ...(value.version === 2 ? { target: parseDraftTarget(value.target) } : {}) };
}

export function serializeRecovery(record: RecoveryRecord): string {
  const raw = JSON.stringify(validateRecord(record));
  checkSize(raw);
  return raw;
}

export function parseRecovery(raw: string): RecoveryRecord {
  checkSize(raw);
  let input: unknown;
  try { input = JSON.parse(raw) as unknown; }
  catch { throw new Error('Recovery record contains invalid JSON.'); }
  const record = validateRecord(input);
  // A compact imported baseline can expand when canonicalized.
  checkSize(JSON.stringify(record));
  return record;
}

/** Corrupt and oversized records stay in storage for explicit export or deletion by the caller. */
export function readRecovery(storage: Pick<RecoveryStorage, 'getItem'>, key: string, prefix = RECOVERY_PREFIX): RecoveryEntry | null {
  let raw: string | null = null;
  try {
    if (!key.startsWith(prefix)) throw new Error('Key is outside the recovery prefix.');
    try { raw = storage.getItem(key); }
    catch (error) { return { key, status: 'corrupt', raw: null, error: message(error), unavailable: true }; }
    if (raw === null) return null;
    try { checkSize(raw); }
    catch (error) { return { key, status: 'corrupt', raw: null, error: message(error) }; }
    const record = parseRecovery(raw);
    if (recoveryKey(record.recordId, prefix) !== key) throw new Error('Recovery record ID does not match its storage key.');
    return { key, status: 'valid', raw, record };
  } catch (error) {
    return { key, status: 'corrupt', raw, error: message(error) };
  }
}

/** Inspect at most 4096 storage keys and 100 recovery records, newest valid records first. */
export function scanRecovery(storage: RecoveryStorage, prefix = RECOVERY_PREFIX): RecoveryScan {
  const result: RecoveryScan = { entries: [], errors: [], truncated: false };
  try {
    recoveryKey('scan', prefix);
    const length = storage.length;
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Storage returned an invalid key count.');
    result.truncated = length > MAX_STORAGE_KEYS;
    const seen = new Set<string>();
    for (let index = 0; index < Math.min(length, MAX_STORAGE_KEYS); index++) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(prefix) || seen.has(key)) continue;
      if (seen.size === MAX_RECOVERY_RECORDS) { result.truncated = true; break; }
      seen.add(key);
      const entry = readRecovery(storage, key, prefix);
      if (entry) {
        result.entries.push(entry);
        if (entry.status === 'corrupt' && entry.unavailable) result.errors.push(`${key}: ${entry.error}`);
      }
    }
  } catch (error) { result.errors.push(message(error)); }
  result.entries.sort((a, b) => (b.status === 'valid' ? b.record.time : -1) - (a.status === 'valid' ? a.record.time : -1));
  return result;
}

/** No cleanup or eviction. Failed validation/read/setItem leaves the last good record intact. */
export function writeRecovery(storage: RecoveryStorage, record: RecoveryRecord, prefix = RECOVERY_PREFIX): RecoveryWrite {
  let key: string | null = null;
  try {
    key = recoveryKey(record.recordId, prefix);
    const raw = serializeRecovery(record);
    const previous = readRecovery(storage, key, prefix);
    if (previous?.status === 'corrupt') throw new Error(`Existing recovery record is unreadable; preserve it before writing: ${previous.error}`);
    if (!previous) {
      const scan = scanRecovery(storage, prefix);
      if (scan.errors.length) throw new Error(scan.errors.join(' '));
      if (scan.truncated || scan.entries.length >= MAX_RECOVERY_RECORDS) throw new Error('Recovery storage reached its record limit. Export or remove an older draft first.');
    }
    storage.setItem(key, raw);
    return { ok: true, key };
  } catch (error) {
    return { ok: false, key, error: message(error) };
  }
}
