import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Palette } from './domain/layout';
import { shutdownFailure } from './domain/shutdown';
import { paletteStyle } from './paletteStyles';
import './shutdown.css';

type RequestState = { kind: 'idle' } | { kind: 'pending' } | { kind: 'error'; message: string };

export function ShutdownDialog({ dialogRef, dirty, preserveDraft, onStopped }: {
  dialogRef: RefObject<HTMLDialogElement | null>; dirty: boolean; preserveDraft: () => boolean; onStopped: () => void;
}) {
  const [request, setRequest] = useState<RequestState>({ kind: 'idle' });
  const pending = request.kind === 'pending';
  async function shutdown() {
    if (pending) return;
    if (!preserveDraft()) {
      setRequest({ kind: 'error', message: 'Your draft could not be backed up. Cancel and export JSON to keep your changes before shutting down.' });
      return;
    }
    setRequest({ kind: 'pending' });
    try {
      const response = await fetch('/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(10000) });
      if (response.status !== 202) { setRequest({ kind: 'error', message: shutdownFailure(response.status) }); return; }
      onStopped();
    } catch { setRequest({ kind: 'error', message: shutdownFailure(null) }); }
  }
  return <dialog ref={dialogRef} className="import-dialog shutdown-dialog" aria-labelledby="shutdown-title" aria-describedby="shutdown-description"
    onCancel={(event) => { if (pending) event.preventDefault(); }} onClose={() => setRequest({ kind: 'idle' })}>
    <h2 id="shutdown-title">Shut down Studio?</h2>
    <p id="shutdown-description">The editor and Ctrl+F9–F12 layout shortcuts stop working until Studio starts again.</p>
    <p>The panel keeps showing its current layout.</p>
    <p>{dirty ? 'You have unsaved changes. They stay in draft recovery in this browser.' : 'Any unsaved changes stay in draft recovery in this browser.'} Uncommitted text and unfinished drags are not backed up.</p>
    {request.kind === 'error' && <p className="shutdown-error" role="alert">{request.message}</p>}
    <div>
      <button autoFocus disabled={pending} onClick={() => dialogRef.current?.close()}>Cancel</button>
      <button className="destructive-action" disabled={pending} onClick={() => void shutdown()}>{pending ? 'Shutting down…' : 'Shut down Studio'}</button>
    </div>
  </dialog>;
}

export function StudioStopped({ palette }: { palette: Palette }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const [request, setRequest] = useState<RequestState>({ kind: 'idle' });
  const [copyMessage, setCopyMessage] = useState('');
  async function copy(command: string) {
    try { await navigator.clipboard.writeText(command); setCopyMessage(`Copied ${command}`); }
    catch { setCopyMessage('Could not copy. Select the command and copy it manually.'); }
  }
  async function reconnect() {
    setRequest({ kind: 'pending' });
    try {
      const response = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      const data: unknown = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      if (!response.ok || typeof data !== 'object' || data === null || !('runtimeRunning' in data) || typeof data.runtimeRunning !== 'boolean') throw new Error('unavailable');
      window.location.reload();
    } catch { setRequest({ kind: 'error', message: 'Studio is not answering yet. Start it with one of the commands above, then reconnect.' }); }
  }
  return <main className="studio shutdown-screen" style={paletteStyle(palette)}>
    <section aria-labelledby="stopped-title">
      <span className="brand-symbol" aria-hidden="true">T</span>
      <h1 id="stopped-title" tabIndex={-1} ref={heading}>Studio is stopped</h1>
      <p>The panel keeps showing its current layout. Your draft recovery stays in this browser.</p>
      <h2>Start Studio again</h2>
      <p>If Studio is installed as a service, run this in a terminal.</p>
      <div className="shutdown-command"><code>systemctl --user start turzx-studio.service</code><button aria-label="Copy service command" onClick={() => void copy('systemctl --user start turzx-studio.service')}>Copy</button></div>
      <p>Otherwise, run this from the Studio repository.</p>
      <div className="shutdown-command"><code>pnpm studio</code><button aria-label="Copy pnpm command" onClick={() => void copy('pnpm studio')}>Copy</button></div>
      <p className="shutdown-copy-status" role="status">{copyMessage}</p>
      <button className="primary-button" disabled={request.kind === 'pending'} onClick={() => void reconnect()}>{request.kind === 'pending' ? 'Connecting…' : 'Reconnect'}</button>
      {request.kind === 'error' && <p role="alert">{request.message}</p>}
    </section>
  </main>;
}
