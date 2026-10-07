import { useEffect, useRef, useState } from 'react';
import './dashboard-styles.css';

const games = [
  { id: 'genshin', name: 'Genshin Impact', resource: 'Original Resin' },
  { id: 'wuwa', name: 'Wuthering Waves', resource: 'Waveplates' },
  { id: 'zzz', name: 'Zenless Zone Zero', resource: 'Battery Charge' },
] as const;
type GameId = typeof games[number]['id'];
type TimerRow = { id: GameId; current: number | null; capacity: number; observedAt: string | null; status: string; note: string };
type TimerSnapshot = { revision: string; games: TimerRow[] };
const message = (failure: unknown) => failure instanceof SyntaxError
  ? 'Studio returned unreadable timer data. Reload timers before trying again.'
  : failure instanceof Error ? failure.message : 'Could not read game timers.';

function parseSnapshot(input: unknown): TimerSnapshot {
  if (!input || typeof input !== 'object') throw new Error('Studio returned invalid timer data.');
  const value = input as TimerSnapshot;
  if (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision) || !Array.isArray(value.games) || value.games.length !== 3
    || !games.every((game, index) => {
      const row = value.games[index];
      return row && row.id === game.id && Number.isSafeInteger(row.capacity) && row.capacity > 0
        && (row.current === null || Number.isSafeInteger(row.current) && row.current >= 0 && row.current <= 10000)
        && typeof row.status === 'string' && typeof row.note === 'string'
        && (row.observedAt === null || typeof row.observedAt === 'string' && Number.isFinite(Date.parse(row.observedAt)));
    })) throw new Error('Studio returned invalid timer data.');
  return value;
}

export default function GameTimers({ open, available, onClose, onChanged }: {
  open: boolean; available: boolean; onClose: () => void; onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<TimerSnapshot | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<GameId, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<GameId, string>>>({});
  const [statuses, setStatuses] = useState<Partial<Record<GameId, string>>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const mustReload = useRef(false);

  async function load() {
    if (pending.current || !available) return;
    pending.current = true; setBusy(true); setError('');
    const sequence = ++generation.current;
    try {
      const response = await fetch('/api/games', { signal: AbortSignal.timeout(8000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not read game timers.');
      const data = parseSnapshot(body);
      if (sequence === generation.current) {
        setSnapshot(data); setDrafts(Object.fromEntries(data.games.map(row => [row.id, row.current === null ? '' : String(row.current)])));
        setErrors({}); setStatuses({}); mustReload.current = false;
      }
    } catch (failure) { if (sequence === generation.current) setError(message(failure)); }
    finally { if (sequence === generation.current) { pending.current = false; setBusy(false); } }
  }

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      setSnapshot(null); setDrafts({}); setErrors({}); setStatuses({}); setError('');
      if (available) void load();
    } else dialog.current?.close();
    // Read once on opening; polling must never replace a typed count.
  }, [open, available]);
  useEffect(() => () => { generation.current += 1; }, []);

  async function update(id: GameId, clear = false) {
    if (pending.current || !snapshot || !available) return;
    if (mustReload.current) { setError('Reload timers before trying again. Your typed counts are kept until you reload.'); return; }
    const draft = drafts[id] ?? '';
    if (!clear && (!/^\d+$/.test(draft) || !Number.isSafeInteger(Number(draft)) || Number(draft) > 10000)) {
      setErrors(current => ({ ...current, [id]: 'Enter a whole number from 0 to 10000.' })); return;
    }
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pending.current = true; setBusy(true); setError(''); setErrors(current => ({ ...current, [id]: '' }));
    mustReload.current = true;
    try {
      const response = await fetch('/api/games', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': snapshot.revision },
        body: JSON.stringify(clear ? { game: id, clear: true } : { game: id, count: Number(draft) }),
        signal: AbortSignal.timeout(8000),
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 422 || response.status === 428) mustReload.current = false;
        throw new Error(body.error ?? 'Count was not saved.');
      }
      const data = parseSnapshot(body);
      setSnapshot(data); mustReload.current = false;
      const row = data.games.find(row => row.id === id)!;
      setDrafts(current => ({ ...current, [id]: row.current === null ? '' : String(row.current) }));
      setStatuses(current => ({ ...current, [id]: clear ? 'Cleared. Not set.' : 'Saved. Timer starts from this count now.' }));
      onChanged();
    } catch (failure) {
      if (!(failure instanceof Error) || failure.name === 'TimeoutError' || failure instanceof TypeError)
        setError('Could not confirm the update. Reload timers before trying again.');
      else setErrors(current => ({ ...current, [id]: message(failure) }));
    } finally {
      pending.current = false; setBusy(false);
      requestAnimationFrame(() => { if (dialog.current?.open && focused && dialog.current.contains(focused)) focused.focus(); });
    }
  }

  return <dialog ref={dialog} className="catalog-dialog game-timers-dialog" aria-labelledby="game-timers-title" aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!pending.current) onClose(); }}>
    <div className="panel-heading"><h2 id="game-timers-title">Game timers</h2><button disabled={busy} aria-label="Close Game timers" onClick={onClose}>×</button></div>
    <p className="panel-note">Enter what each game shows now. These shared timers count up on every dashboard. Update the count after spending or refilling resources.</p>
    {!available && <p className="panel-note">Open Studio's local server to set shared timers. Offline previews show sample counts.</p>}
    {error && <p role="alert" className="timer-error">{error}</p>}
    {games.map(game => {
      const row = snapshot?.games.find(row => row.id === game.id);
      return <section className="timer-row" key={game.id} aria-labelledby={`timer-heading-${game.id}`}>
        <h3 id={`timer-heading-${game.id}`}>{game.name}</h3>
        <p>{game.resource}{row && ` · regeneration cap ${row.capacity}`}</p>
        <div className="timer-controls">
          <label htmlFor={`timer-count-${game.id}`}>{game.resource} count
            <input id={`timer-count-${game.id}`} inputMode="numeric" autoComplete="off" value={drafts[game.id] ?? ''}
              disabled={busy || !snapshot || !available} aria-invalid={Boolean(errors[game.id])}
              aria-describedby={`timer-state-${game.id}`}
              onChange={event => { setDrafts(current => ({ ...current, [game.id]: event.target.value })); setErrors(current => ({ ...current, [game.id]: '' })); }}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void update(game.id); } }} />
          </label>
          <button disabled={busy || !snapshot || !available} onClick={() => void update(game.id)}>Save count</button>
          <button disabled={busy || !snapshot || !available || row?.status === 'not-configured'} onClick={() => void update(game.id, true)}>Clear</button>
        </div>
        <p id={`timer-state-${game.id}`} aria-live="polite">{statuses[game.id] || (row?.status === 'unavailable' ? row.note : row?.observedAt ? `Estimated ${row.current ?? '—'}. Count set ${new Date(row.observedAt).toLocaleString()}.` : row?.note || (busy ? 'Loading timers…' : 'Not set.'))}</p>
        {errors[game.id] && <p role="alert" className="timer-error">{errors[game.id]}</p>}
      </section>;
    })}
    <div className="timer-footer"><button disabled={busy || !available} onClick={() => void load()}>Reload timers</button><button disabled={busy} onClick={onClose}>Close</button></div>
  </dialog>;
}
