import { useEffect, useState } from 'react';
import './preview-sources.css';

type Source = { id: string; label: string; value: string | number | null; unit: string; status: string; observedAt?: number; samples?: number };
type Live = { available: boolean; sources: Source[]; error?: string };
type Freshness = { status?: string; stale?: boolean; observedAt?: number | string | null; errors?: string[] };
type Provider = { total?: number | null; limits?: { label: string; usedPercent: number; stale: boolean; observedAt?: number | string }[]; freshness?: { tokens?: Freshness; limits?: Freshness } };
type Usage = { providers?: { codex?: Provider; claude?: Provider } };

function observation(time?: number | string | null) {
  const stamp = typeof time === 'number' ? time * 1000 : typeof time === 'string' ? Date.parse(time) : NaN;
  return Number.isFinite(stamp) ? new Date(stamp).toLocaleTimeString() : 'Unknown';
}

function sourceRows(value: unknown): Live {
  if (!value || typeof value !== 'object') throw new Error('Studio returned invalid source diagnostics.');
  const raw = value as Live;
  if (typeof raw.available !== 'boolean' || !Array.isArray(raw.sources) || raw.sources.length > 64) throw new Error('Studio returned invalid source diagnostics.');
  for (const row of raw.sources) {
    if (!row || typeof row.id !== 'string' || typeof row.label !== 'string' || typeof row.unit !== 'string' || !['ok', 'stale', 'unavailable'].includes(row.status) || row.value !== null && typeof row.value !== 'string' && !(typeof row.value === 'number' && Number.isFinite(row.value))) throw new Error('Studio returned invalid source diagnostics.');
  }
  return raw;
}

export default function PreviewSources({ available, mode, onMode }: {
  available: boolean; mode: 'sample' | 'live'; onMode: (mode: 'sample' | 'live') => void;
}) {
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || !available) return;
    let canceled = false, pending = false;
    let controller: AbortController | null = null;
    async function poll() {
      if (pending || window.document.hidden) return;
      pending = true; controller = new AbortController();
      const signal = controller.signal;
      const timeout = window.setTimeout(() => controller?.abort(), 8000);
      try {
        const [readings, tokens] = await Promise.all([fetch('/api/live', { signal }), fetch('/api/usage', { signal })]);
        if (!readings.ok) throw new Error('Live readings are unavailable. The Studio server needs the current adapter.');
        const next = sourceRows(await readings.json());
        const nextUsage = tokens.ok ? await tokens.json().catch(() => null) : null;
        if (!canceled) { setLive(next); setUsage(nextUsage); setError(''); }
      } catch (failure) {
        if (!canceled) setError(failure instanceof Error ? failure.message : 'Source diagnostics are unavailable.');
      } finally { pending = false; window.clearTimeout(timeout); }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    const visible = () => { if (!window.document.hidden) void poll(); };
    window.document.addEventListener('visibilitychange', visible);
    return () => { canceled = true; controller?.abort(); window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visible); };
  }, [available, open]);

  return <div className="preview-sources">
    <div className="preview-mode" role="group" aria-label="Preview data">
      <span>Preview data</span>
      <button type="button" aria-pressed={mode === 'sample'} onClick={() => onMode('sample')}>Sample</button>
      <button type="button" aria-pressed={mode === 'live'} disabled={!available} onClick={() => onMode('live')}>Live</button>
      <span className="preview-mode-note">{mode === 'live' ? 'Updates every 2 seconds' : 'Fixed values for arranging cards'}</span>
    </div>
    <details className="source-details" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Data sources</summary>
      {!available ? <p>Connect to the local Studio server to inspect runtime readings.</p> : <>
        {error && <p role="status">{error} Previous readings are stale.</p>}
        {live?.error && <p role="status">{live.error}</p>}
        {!live && !error && <p role="status">Reading source diagnostics…</p>}
        {live && <div className="source-table-scroll"><table className="source-table"><thead><tr><th>Source</th><th>Reading</th><th>Status</th><th>Observed</th></tr></thead><tbody>
          {live.sources.map((source) => <tr key={source.id}>
            <th scope="row">{source.label}</th>
            <td>{source.value === null || source.value === '' ? 'Unknown' : `${typeof source.value === 'number' ? Number(source.value.toFixed(1)) : source.value} ${source.unit}`}</td>
            <td>{error ? 'stale' : source.status}{source.samples ? ` · ${source.samples} readings` : ''}</td>
            <td>{observation(source.observedAt)}</td>
          </tr>)}
          {(['codex', 'claude'] as const).map((name) => {
            const provider = usage?.providers?.[name], fresh = provider?.freshness?.tokens;
            const limits = Array.isArray(provider?.limits) ? provider.limits.filter((limit) => limit && typeof limit.label === 'string' && typeof limit.usedPercent === 'number' && Number.isFinite(limit.usedPercent)) : [];
            return <tr key={name}><th scope="row">{name === 'codex' ? 'Codex Pro quota' : 'Claude quota'}</th>
              <td>{limits.length ? limits.map((limit) => `${limit.label}: ${Number(limit.usedPercent.toFixed(1))}% observed`).join(', ') : 'Unknown'}</td>
              <td>{error ? 'stale' : limits.length ? limits.some((limit) => limit.stale) ? 'stale' : 'cached' : 'unavailable'}</td>
              <td>{observation(provider?.freshness?.limits?.observedAt)}<span className="source-token-note">{typeof provider?.total === 'number' ? `${provider.total.toLocaleString()} tokens today · ${fresh?.status ?? 'unknown freshness'}` : 'Token totals unavailable'}</span></td>
            </tr>;
          })}
        </tbody></table></div>}
        <p className="source-footnote">Readings come from the running dashboard. Provider quotas are local cached observations. Unknown readings stay unknown. Previewing leaves the panel layout unchanged.</p>
      </>}
    </details>
  </div>;
}
