import { useEffect, useRef, useState } from 'react';
import { parseLayout, serializeLayout } from './domain/layout';
import type { LayoutDocument } from './domain/layout';
import { groupArchives, parseArchives, parseLibrary } from './domain/library';
import type { Archive, ArchiveGroup } from './domain/library';
import { StaticLayout } from './WidgetContent';
import './history-styles.css';

type ArchiveTarget = { kind: 'archive'; archiveId: string; createdAt: string };
type ArchiveRead = { document: LayoutDocument; archiveId: string };
type Thumbnail = { document?: LayoutDocument; error?: string };
type ReadJob = { archive: Archive; resolve: (read: ArchiveRead) => void; reject: (failure: unknown) => void };

function reasonLabel(reason: string) {
  return reason === 'panel-save' ? 'Replaced on panel'
    : reason === 'saved-layout-list-change' ? 'Replaced in library' : reason;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function errorMessage(failure: unknown) {
  if (failure instanceof Error && failure.name === 'TimeoutError') return 'History request timed out. Refresh History to try again.';
  const message = failure instanceof Error ? failure.message : 'Archive could not be read. Refresh History to try again.';
  return /checksum/i.test(message) ? 'This archive failed its checksum. It is kept unchanged.' : message;
}

function HistoryRow({ group, thumbnail, matchesPanel, libraryNames, working, loadThumbnail, open, download }: {
  group: ArchiveGroup; thumbnail?: Thumbnail; matchesPanel: boolean; libraryNames: string[]; working: boolean;
  loadThumbnail: (archive: Archive) => void; open: (archive: Archive) => void; download: (archive: Archive) => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const archive = group.copies[0];
  useEffect(() => {
    if (!row.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { loadThumbnail(archive); observer.disconnect(); }
    }, { root: row.current.closest('dialog'), rootMargin: '120px' });
    observer.observe(row.current);
    return () => observer.disconnect();
  }, [archive, loadThumbnail]);
  return <li ref={row} className="history-row">
    <div className="history-thumbnail">{thumbnail?.document ? <StaticLayout document={thumbnail.document} />
      : <span>{thumbnail?.error ? 'Preview unavailable' : 'Loading preview…'}</span>}</div>
    <div className="history-entry-info">
      <h3>{archive.name}</h3>
      <div className="history-badges">{matchesPanel && <span>Matches panel</span>}{libraryNames.map((name, index) => <span key={`${name}-${index}`}>In library: {name}</span>)}</div>
      <p className="history-entry-meta">{reasonLabel(archive.reason)}<time dateTime={archive.createdAt}>{formatDate(archive.createdAt)}</time></p>
      {thumbnail?.error && <p className="history-read-error" role="alert">{thumbnail.error}</p>}
      <div className="history-entry-actions"><button disabled={working || !!thumbnail?.error} className="primary-button" onClick={() => open(archive)}>Open as draft</button><button disabled={working || !!thumbnail?.error} onClick={() => download(archive)}>Download JSON</button></div>
      <details className="history-copies"><summary>{group.copies.length === 1 ? 'Archive details' : `${group.copies.length} copies`}</summary><ul>{group.copies.map((copy) => <li key={copy.id}>
        <code>{copy.id}</code><span>{reasonLabel(copy.reason)}</span><time dateTime={copy.createdAt}>{formatDate(copy.createdAt)}</time>
        {group.copies.length > 1 && <div><button disabled={working} aria-label={`Open archive ${copy.id} as draft`} onClick={() => open(copy)}>Open this copy</button><button disabled={working} aria-label={`Download archive ${copy.id} JSON`} onClick={() => download(copy)}>Download this copy</button></div>}
      </li>)}</ul></details>
    </div>
  </li>;
}

export default function HistoryDialog({ available, onOpen }: {
  available: boolean; onOpen: (document: LayoutDocument, target: ArchiveTarget) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [groups, setGroups] = useState<ArchiveGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [thumbnails, setThumbnails] = useState<Record<string, Thumbnail>>({});
  const [panelText, setPanelText] = useState<string | null>(null);
  const [libraryTexts, setLibraryTexts] = useState<{ name: string; text: string }[]>([]);
  const [contextError, setContextError] = useState('');
  const [originalCreatedAt, setOriginalCreatedAt] = useState<string | null>(null);
  const cache = useRef(new Map<string, ArchiveRead>());
  const failures = useRef(new Map<string, string>());
  const pending = useRef(new Map<string, Promise<ArchiveRead>>());
  const queue = useRef<ReadJob[]>([]);
  const activeReads = useRef(0);
  const actionPending = useRef(false);
  const listPending = useRef(false);
  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true; abort.current = new AbortController();
    return () => { mounted.current = false; abort.current?.abort(); };
  }, []);

  // All archive reads, including explicit copy actions, share this four-request pool.
  function pump() {
    while (activeReads.current < 4 && queue.current.length) {
      const job = queue.current.shift()!;
      activeReads.current++;
      void (async () => {
        try {
          const timeout = AbortSignal.timeout(8000);
          const response = await fetch(`/api/history/${encodeURIComponent(job.archive.id)}`, {
            signal: abort.current ? AbortSignal.any([abort.current.signal, timeout]) : timeout,
          });
          const raw: unknown = await response.json();
          if (!response.ok) throw new Error(raw && typeof raw === 'object' && 'error' in raw && typeof raw.error === 'string' ? raw.error : 'Archive could not be read. Refresh History to try again.');
          if (!raw || typeof raw !== 'object' || !('document' in raw) || !('revision' in raw)
            || raw.revision !== job.archive.revision) throw new Error('Archive revision does not match History. Refresh History to try again.');
          const result = { document: parseLayout(JSON.stringify(raw.document)), archiveId: job.archive.id };
          cache.current.set(job.archive.revision, result);
          failures.current.delete(job.archive.id);
          if (mounted.current) setThumbnails((current) => ({ ...current, [job.archive.revision]: { document: result.document } }));
          job.resolve(result);
        } catch (failure) {
          const message = errorMessage(failure);
          failures.current.set(job.archive.id, message);
          if (mounted.current && !cache.current.has(job.archive.revision)) {
            setThumbnails((current) => ({ ...current, [job.archive.revision]: { error: message } }));
          }
          job.reject(new Error(message));
        } finally {
          pending.current.delete(job.archive.id); activeReads.current--; pump();
        }
      })();
    }
  }

  function read(archive: Archive): Promise<ArchiveRead> {
    const cached = cache.current.get(archive.revision);
    if (cached?.archiveId === archive.id) return Promise.resolve(cached);
    const failure = failures.current.get(archive.id);
    if (failure) return Promise.reject(new Error(failure));
    const existing = pending.current.get(archive.id);
    if (existing) return existing;
    const request = new Promise<ArchiveRead>((resolve, reject) => { queue.current.push({ archive, resolve, reject }); });
    pending.current.set(archive.id, request); pump();
    return request;
  }

  const loadThumbnailRef = useRef((archive: Archive) => { void read(archive).catch(() => {}); });
  loadThumbnailRef.current = (archive: Archive) => {
    const cached = cache.current.get(archive.revision);
    if (cached) { setThumbnails((current) => ({ ...current, [archive.revision]: { document: cached.document } })); return; }
    void read(archive).catch(() => {});
  };
  const [loadThumbnail] = useState(() => (archive: Archive) => loadThumbnailRef.current(archive));

  async function show() {
    if (!dialog.current?.open) dialog.current?.showModal();
    if (listPending.current || actionPending.current) return;
    listPending.current = true; setLoading(true); setError(''); setGroups(null);
    failures.current.clear(); setThumbnails({}); setPanelText(null); setLibraryTexts([]); setContextError('');
    try {
      const response = await fetch('/api/history', { signal: AbortSignal.timeout(8000) });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : 'History is unavailable. Refresh History to try again.');
      const next = groupArchives(parseArchives(data));
      setGroups(next);
      const original = data && typeof data === 'object' && 'original' in data ? data.original : null;
      setOriginalCreatedAt(original && typeof original === 'object' && 'createdAt' in original
        && typeof original.createdAt === 'string' && Number.isFinite(Date.parse(original.createdAt)) ? original.createdAt : null);
      const context = await Promise.allSettled([
        fetch('/api/layout', { signal: AbortSignal.timeout(8000) }).then(async (response) => {
          const data: unknown = await response.json();
          if (!response.ok || !data || typeof data !== 'object' || !('document' in data)) throw new Error('Panel matches are unavailable.');
          return serializeLayout(parseLayout(JSON.stringify(data.document)));
        }),
        fetch('/api/layouts', { signal: AbortSignal.timeout(8000) }).then(async (response) => {
          if (!response.ok) throw new Error('Library matches are unavailable.');
          return parseLibrary(await response.json()).entries.map((entry) => ({ name: entry.name, text: serializeLayout(entry.document) }));
        }),
      ]);
      if (context[0].status === 'fulfilled') setPanelText(context[0].value);
      if (context[1].status === 'fulfilled') setLibraryTexts(context[1].value);
      if (context.some((result) => result.status === 'rejected')) setContextError('Some panel or library matches could not be checked. History is still available.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { listPending.current = false; setLoading(false); }
  }

  async function act(archive: Archive, download: boolean) {
    if (actionPending.current) return;
    actionPending.current = true; setWorking(true); setError('');
    try {
      const result = await read(archive);
      if (download) {
        const url = URL.createObjectURL(new Blob([serializeLayout(result.document)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `${archive.id}.json`;
        document.body.append(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        dialog.current?.close();
        onOpen(parseLayout(serializeLayout(result.document)), { kind: 'archive', archiveId: archive.id, createdAt: archive.createdAt });
      }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { actionPending.current = false; setWorking(false); }
  }

  return <>
    {available && <button onClick={() => void show()}>History</button>}
    <dialog ref={dialog} className="catalog-dialog history-dialog" aria-labelledby="history-title">
      <div className="panel-heading"><h2 id="history-title">History</h2><button aria-label="Close History" onClick={() => dialog.current?.close()}>×</button></div>
      <p className="history-lede">Previous panel dashboards and library entries. Open a copy as a draft to edit it. The panel changes when you choose Save to panel.</p>
      <div className="history-toolbar"><span>{groups && `${groups.length} layouts, ${groups.reduce((total, group) => total + group.copies.length, 0)} archives`}</span><button disabled={loading || working} onClick={() => void show()}>Refresh History</button></div>
      {error && <p className="history-read-error" role="alert">{error}</p>}
      {contextError && <p className="panel-note">{contextError}</p>}
      {!groups && !error && <p className="panel-note">Loading History…</p>}
      {groups?.length === 0 && <p className="panel-note">No archived layouts yet. Replacing a panel dashboard or library entry keeps its previous document here.</p>}
      {groups && <ol className="history-list">{groups.map((group) => {
        const thumbnail = thumbnails[group.revision];
        const text = thumbnail?.document ? serializeLayout(thumbnail.document) : null;
        return <HistoryRow key={group.revision} group={group} thumbnail={thumbnail} working={working}
          matchesPanel={text !== null && text === panelText} libraryNames={text ? libraryTexts.filter((entry) => entry.text === text).map((entry) => entry.name) : []}
          loadThumbnail={loadThumbnail} open={(archive) => void act(archive, false)} download={(archive) => void act(archive, true)} />;
      })}</ol>}
      <div className="history-original"><h3>Original dashboard program</h3>
        {originalCreatedAt && <time dateTime={originalCreatedAt}>{formatDate(originalCreatedAt)}</time>}
        <p>The original backup contains source code, USB driver, settings and service configuration from before Studio. It is separate from layout history and cannot be opened as a draft. <code>pnpm panel:rollback</code> reinstates that program using its original Python environment.</p>
      </div>
    </dialog>
  </>;
}
