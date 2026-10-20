import { useEffect, useRef, useState } from 'react';
import { CLIPBOARD_STORAGE_KEY, emptyClipboard, forgetClip, mergeClipboard, parseClipboard, rememberClip, serializeClipboard } from './domain/clipboard';
import type { ClipEntry, WidgetClipboard } from './domain/clipboard';

function read(): { clipboard: WidgetClipboard; error: string } {
  try {
    const { clipboard, dropped } = parseClipboard(localStorage.getItem(CLIPBOARD_STORAGE_KEY));
    return { clipboard, error: dropped ? `${dropped === 1 ? 'One clipboard entry was' : `${dropped} clipboard entries were`} unreadable and skipped.` : '' };
  } catch { return { clipboard: emptyClipboard, error: 'Browser storage is unavailable. Copies last until this tab closes.' }; }
}

const tabOnlyWarning = 'Browser storage is full or unavailable. Some copies live only in this tab until it closes.';

/** Shared by every tab in this browser; a copy in one tab can be pasted in another. */
export default function useWidgetClipboard() {
  const [state, setState] = useState(read);
  const current = useRef(state.clipboard);
  const stored = useRef(state.clipboard);
  const unpersisted = useRef(emptyClipboard);
  current.current = state.clipboard;

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== CLIPBOARD_STORAGE_KEY && event.key !== null) return;
      const incoming = read();
      stored.current = incoming.clipboard;
      const clipboard = mergeClipboard(unpersisted.current, incoming.clipboard);
      unpersisted.current = { version: 1, entries: unpersisted.current.entries.filter((clip) => clipboard.entries.includes(clip) && !incoming.clipboard.entries.some((stored) => stored.id === clip.id)) };
      current.current = clipboard;
      setState({ clipboard, error: [incoming.error, unpersisted.current.entries.length ? tabOnlyWarning : ''].filter(Boolean).join(' ') });
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  function store(next: WidgetClipboard) {
    let kept = next;
    let persisted = false;
    // Embedded images can exceed the quota. Retain copies that do not fit in this tab.
    for (;;) {
      try {
        if (kept.entries.length) localStorage.setItem(CLIPBOARD_STORAGE_KEY, serializeClipboard(kept));
        else localStorage.removeItem(CLIPBOARD_STORAGE_KEY);
        persisted = true;
        break;
      } catch {
        if (kept.entries.length <= 1) break;
        kept = { version: 1, entries: kept.entries.slice(0, -1) };
      }
    }
    if (persisted) stored.current = kept;
    unpersisted.current = { version: 1, entries: next.entries.filter((clip) => !stored.current.entries.includes(clip)) };
    const warning = unpersisted.current.entries.length ? tabOnlyWarning : !persisted ? 'Could not clear browser storage. Saved copies may return after reloading.' : '';
    current.current = next;
    setState({ clipboard: next, error: warning });
    return { persisted, warning };
  }

  return {
    entries: state.clipboard.entries,
    error: state.error,
    latest: () => current.current.entries[0] as ClipEntry | undefined,
    remember: (entry: ClipEntry) => store(rememberClip(current.current, entry)),
    forget: (id: string) => store(forgetClip(current.current, id)),
    clear: () => store(emptyClipboard),
  };
}
