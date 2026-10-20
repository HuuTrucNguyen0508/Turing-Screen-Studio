import { useEffect, useRef, useState } from 'react';
import { CLIPBOARD_STORAGE_KEY, emptyClipboard, forgetClip, parseClipboard, rememberClip, serializeClipboard } from './domain/clipboard';
import type { ClipEntry, WidgetClipboard } from './domain/clipboard';

function read(): { clipboard: WidgetClipboard; error: string } {
  try {
    const { clipboard, dropped } = parseClipboard(localStorage.getItem(CLIPBOARD_STORAGE_KEY));
    return { clipboard, error: dropped ? `${dropped === 1 ? 'One clipboard entry was' : `${dropped} clipboard entries were`} unreadable and skipped.` : '' };
  } catch { return { clipboard: emptyClipboard, error: 'Browser storage is unavailable. Copies last until this tab closes.' }; }
}

/** Shared by every tab in this browser; a copy in one tab can be pasted in another. */
export default function useWidgetClipboard() {
  const [state, setState] = useState(read);
  const current = useRef(state.clipboard);
  current.current = state.clipboard;

  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === CLIPBOARD_STORAGE_KEY || event.key === null) setState(read()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  function store(next: WidgetClipboard) {
    let kept = next;
    let error = '';
    // Embedded images can exceed the storage quota. Drop the oldest copies until the rest fit.
    for (;;) {
      try {
        if (kept.entries.length) localStorage.setItem(CLIPBOARD_STORAGE_KEY, serializeClipboard(kept));
        else localStorage.removeItem(CLIPBOARD_STORAGE_KEY);
        break;
      } catch {
        if (kept.entries.length <= 1) { error = 'This copy is too large for browser storage. It lasts until this tab closes.'; break; }
        kept = { version: 1, entries: kept.entries.slice(0, -1) };
        error = 'Browser storage is full. Older clipboard entries were removed.';
      }
    }
    const value = error.startsWith('This copy') ? next : kept;
    current.current = value;
    setState({ clipboard: value, error });
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
