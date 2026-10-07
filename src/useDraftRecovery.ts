import { useEffect, useRef, useState } from 'react';
import type { EditorState } from './domain/editor';
import { serializeLayout } from './domain/layout';
import { createRecoveryId, readRecovery, recoveryKey, scanRecovery, writeRecovery } from './domain/recovery';
import type { RecoveryEntry, RecoveryRecord, RecoveryScan } from './domain/recovery';

const instanceId = createRecoveryId(() => crypto.randomUUID());
const leasePrefix = 'turzx-studio:recovery-active:';
const lockPrefix = 'turzx-studio:recovery-owner:';
const leaseDuration = 180000;

function leaseActive(entry: RecoveryEntry): boolean {
  if (entry.status !== 'valid' || entry.record.recordId === instanceId) return false;
  try { return Date.now() - Number(localStorage.getItem(leasePrefix + entry.record.recordId) || 0) < leaseDuration; }
  catch { return false; }
}

function scan(): RecoveryScan {
  try { return scanRecovery(localStorage); }
  catch (failure) { return { entries: [], errors: [failure instanceof Error ? failure.message : 'Draft storage is unavailable.'], truncated: false }; }
}

export default function useDraftRecovery(editor: EditorState) {
  const [initial] = useState(scan);
  const [entries, setEntries] = useState(initial.entries);
  const [pending, setPending] = useState(initial.entries.some((entry) => !leaseActive(entry)));
  const [, setOwners] = useState<Set<string> | null>(null);
  const startupDecided = useRef(false);
  const ownersRef = useRef<Set<string> | null>(null);
  const [error, setError] = useState(initial.errors.join(' '));
  const [backedUp, setBackedUp] = useState(false);
  const [time, setTime] = useState<number | null>(null);
  const restoredKey = useRef<{ key: string; raw: string } | null>(null);
  const savedRef = useRef<string | null>(null);
  const current = useRef(editor);
  current.current = editor;
  const ready = useRef(!pending);
  ready.current = !pending;
  const recordKey = recoveryKey(instanceId);

  function activeElsewhere(entry: RecoveryEntry): boolean {
    if (entry.status !== 'valid' || entry.record.recordId === instanceId) return false;
    const active = ownersRef.current;
    return active ? active.has(entry.record.recordId) : navigator.locks ? true : leaseActive(entry);
  }

  function persist(force = false) {
    if (!ready.current && !force) return;
    const editor = current.current;
    // Back up the transaction origin while a pointer gesture is in progress.
    const state = editor.gesture ? { ...editor, document: editor.gesture.document } : editor;
    const text = serializeLayout(state.document);
    if (text === state.baseline) {
      try { localStorage.removeItem(recordKey); savedRef.current = null; setBackedUp(false); }
      catch { setError('Draft storage could not be cleared. Export JSON to keep a copy.'); }
      return;
    }
    const identity = text + state.baseline + state.baseRevision + JSON.stringify(state.target);
    if (savedRef.current === identity) {
      try { if (localStorage.getItem(recordKey) !== null) return; }
      catch { /* Report the failed write below. */ }
    }
    const now = Date.now();
    let storage: Storage;
    try { storage = localStorage; }
    catch { setError('Draft storage is unavailable. Export JSON to keep your work.'); setBackedUp(false); return; }
    const result = writeRecovery(storage, {
      version: 2, document: state.document, baseline: state.baseline, baseRevision: state.baseRevision, target: state.target,
      source: state.target.kind === 'library' ? `Library: ${state.target.entryName}` : state.target.kind === 'archive' ? 'History draft' : state.target.kind === 'panel' ? 'Panel dashboard' : 'Local draft', title: state.document.name, time: now, recordId: instanceId,
    });
    if (!result.ok) { setError(`Draft backup failed. ${result.error} Export JSON to keep your work.`); setBackedUp(false); return; }
    savedRef.current = identity; setBackedUp(true); setTime(now); setError('');
    if (restoredKey.current) {
      const { key, raw } = restoredKey.current;
      try {
        const entry = readRecovery(localStorage, key);
        // Never remove another page's record using a timer lease as proof of ownership.
        if (entry && entry.raw === raw && ownersRef.current && !activeElsewhere(entry)) localStorage.removeItem(key);
      } catch { /* The verified new copy exists; retain the older copy on cleanup failure. */ }
      restoredKey.current = null;
    }
  }

  useEffect(() => {
    let canceled = false;
    let releaseLock: (() => void) | undefined;
    if (navigator.locks) {
      void navigator.locks.request(lockPrefix + instanceId, async () => {
        if (canceled) return;
        await new Promise<void>((resolve) => { releaseLock = resolve; });
      }).catch(() => { /* Timestamp lease remains available as a fallback. */ });
    }
    async function queryOwners() {
      if (!navigator.locks) return;
      try {
        const locks = await navigator.locks.query();
        if (canceled) return;
        const active = new Set((locks.held ?? []).flatMap((lock) => lock.name?.startsWith(lockPrefix) ? [lock.name.slice(lockPrefix.length)] : []));
        ownersRef.current = active; setOwners(active);
        if (!startupDecided.current) { startupDecided.current = true; const latest = scan(); const candidates = latest.entries.filter((entry) => entry.key !== recordKey); setEntries(candidates); setPending(candidates.some((entry) => entry.status !== 'valid' || !active.has(entry.record.recordId))); }
      } catch { /* Keep the conservative timestamp lease. */ }
    }
    void queryOwners();
    const heartbeat = () => { try { localStorage.setItem(leasePrefix + instanceId, String(Date.now())); } catch { /* Backup reports storage failure separately. */ } };
    heartbeat();
    const timer = window.setInterval(() => { heartbeat(); void queryOwners(); }, 5000);
    const leave = (event: PageTransitionEvent) => { persist(true); if (!event.persisted) { releaseLock?.(); try { localStorage.removeItem(leasePrefix + instanceId); } catch { /* Lease expires after a crash. */ } } };
    window.addEventListener('pagehide', leave);
    const hidden = () => { if (document.visibilityState === 'hidden') persist(true); else { heartbeat(); void queryOwners(); } };
    const storageChanged = (event: StorageEvent) => { if (event.key === recordKey && event.newValue === null) { savedRef.current = null; persist(true); } void queryOwners(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('storage', storageChanged);
    return () => { canceled = true; releaseLock?.(); window.clearInterval(timer); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('storage', storageChanged); try { localStorage.removeItem(leasePrefix + instanceId); } catch { /* Lease expires. */ } };
  }, []);

  useEffect(() => {
    if (pending) return;
    if (editor.gesture) { persist(); return; }
    setBackedUp(false);
    const timer = window.setTimeout(persist, 300);
    return () => window.clearTimeout(timer);
  }, [editor.document, editor.baseline, editor.baseRevision, editor.target, editor.gesture, pending]);

  function refresh() { persist(true); startupDecided.current = true; const next = scan(); setEntries(next.entries.filter((entry) => entry.key !== recordKey)); setError(next.errors.join(' ')); setPending(true); }
  function restore(entry: RecoveryEntry): RecoveryRecord | null {
    try { const fresh = readRecovery(localStorage, entry.key); if (!fresh) { setError('This backup is no longer available.'); return null; } entry = fresh; } catch { setError('This backup could not be read. It has been kept in storage.'); return null; }
    if (entry.status !== 'valid') { setError(entry.error); return null; }
    const state = current.current;
    if (serializeLayout(state.document) !== state.baseline) {
      // Keep a separate recovery copy before this page's ordinary backup is replaced.
      try {
        const preserved = writeRecovery(localStorage, { version: 2, document: state.document, baseline: state.baseline, target: state.target,
          baseRevision: state.baseRevision, source: 'Before restoring another draft', title: state.document.name,
          time: Date.now(), recordId: createRecoveryId(() => crypto.randomUUID()) });
        if (!preserved.ok) throw new Error(preserved.error);
      } catch (failure) { setError(`The current draft could not be preserved. ${failure instanceof Error ? failure.message : 'Export it before restoring.'}`); return null; }
    }
    startupDecided.current = true;
    restoredKey.current = activeElsewhere(entry) ? null : { key: entry.key, raw: entry.raw };
    setPending(false); ready.current = true; setEntries([]);
    return entry.record;
  }
  function discard(entry: RecoveryEntry) {
    if (activeElsewhere(entry)) { setError('This draft is open in another tab. Restore a copy or close that tab first.'); return; }
    try { const fresh = readRecovery(localStorage, entry.key); if (fresh && fresh.raw !== entry.raw) { setEntries((items) => items.map((item) => item.key === entry.key ? fresh : item)); setError('This backup changed. Review its latest version before discarding it.'); return; } localStorage.removeItem(entry.key); setEntries((items) => items.filter((item) => item.key !== entry.key)); }
    catch { setError('The draft could not be removed. It remains available for recovery.'); }
  }
  return { entries, pending, error, backedUp, time, refresh, restore, discard, activeElsewhere,
    close() { startupDecided.current = true; setPending(false); ready.current = true; },
  };
}
