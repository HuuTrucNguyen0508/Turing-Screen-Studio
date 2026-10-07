import { useEffect, useRef, useState } from 'react';
import { parseCustomWidgets, serializeCustomWidgets, validateCustomWidgets } from './domain/widgetTemplates';
import type { CustomWidgets } from './domain/widgetTemplates';

const key = 'turzx-studio.custom-widgets.v1';
const empty: CustomWidgets = { version: 1, widgets: [] };

export default function useCustomWidgets(available: boolean) {
  const [document, setDocument] = useState<CustomWidgets>(empty);
  const [browserOnly, setBrowserOnly] = useState(false);
  const [mode, setMode] = useState<'browser' | 'server'>('browser');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const baseline = useRef<string | null>(null);
  const generation = useRef(0);
  const operation = useRef(false);

  async function refresh() {
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      if (available && !browserOnly) {
        const response = await fetch('/api/widgets', { signal: AbortSignal.timeout(8000) });
        if (response.status !== 404) {
          const raw = await response.json();
          if (!response.ok) throw new Error(raw.error ?? 'Custom widgets could not be read.');
          const checked = validateCustomWidgets({ version: raw.version, widgets: raw.widgets });
          if (typeof raw.revision !== 'string' || !raw.revision) throw new Error('Custom widget revision is invalid.');
          if (request !== generation.current) return;
          setMode('server'); baseline.current = raw.revision; setDocument(checked); return;
        }
      }
      const raw = localStorage.getItem(key);
      const checked = raw === null ? empty : parseCustomWidgets(raw);
      if (request !== generation.current) return;
      setMode('browser'); baseline.current = raw; setDocument(checked);
    } catch (failure) { if (request === generation.current) { baseline.current = null; setError(failure instanceof Error ? failure.message : 'Custom widget storage is unavailable. Export a copy before repairing it.'); } }
    finally { if (request === generation.current) setLoading(false); }
  }

  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [available, browserOnly]);

  const observedGeneration = generation.current;
  const observedRevision = baseline.current;

  async function save(next: CustomWidgets): Promise<boolean> {
    if (operation.current || loading || error) return false;
    if (generation.current !== observedGeneration || baseline.current !== observedRevision) { setError('Custom widgets changed while this operation was prepared. Refresh before trying again.'); return false; }
    const checked = validateCustomWidgets(next);
    const request = observedGeneration;
    operation.current = true; setWorking(true);
    try {
      if (mode === 'server') {
        const response = await fetch('/api/widgets', { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': observedRevision! }, body: serializeCustomWidgets(checked), signal: AbortSignal.timeout(8000) });
        const raw = await response.json();
        if (!response.ok) throw new Error(raw.error ?? 'Custom widgets changed elsewhere. Refresh before saving.');
        const saved = validateCustomWidgets({ version: raw.version, widgets: raw.widgets });
        if (typeof raw.revision !== 'string' || !raw.revision) throw new Error('The saved custom widgets could not be verified.');
        if (request === generation.current) { setDocument(saved); baseline.current = raw.revision; }
      } else {
        if (localStorage.getItem(key) !== observedRevision) throw new Error('Custom widgets changed in another tab. Refresh before saving.');
        const text = serializeCustomWidgets(checked);
        // Web Locks serializes the compare/write pair across tabs where supported.
        const write = () => { if (localStorage.getItem(key) !== observedRevision) throw new Error('Custom widgets changed in another tab. Refresh before saving.'); localStorage.setItem(key, text); };
        if (navigator.locks) await navigator.locks.request('turzx-studio:custom-widgets', write); else write();
        if (request === generation.current) { baseline.current = text; setDocument(checked); }
      }
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Custom widgets could not be saved. The previous copy is intact.'); return false; }
    finally { operation.current = false; setWorking(false); }
  }

  return { document, browserOnly, machineAvailable: available, showBrowser: () => setBrowserOnly(true), showMachine: () => setBrowserOnly(false), loading, working, error, refresh, save, storeLabel: mode === 'server' ? 'Saved on this machine' : 'Saved in this browser' };
}
