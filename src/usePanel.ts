import { useEffect, useRef, useState } from 'react';
import { parseLayout, serializeLayout } from './domain/layout';
import type { LayoutDocument, Palette } from './domain/layout';
import type { LayoutSelection } from './SavedLayouts';

export type PanelStatus = { runtimeRunning?: boolean; connected?: boolean; usbPresent?: boolean; appliedRevision?: string | null; requestedRevision?: string | null; frameRevision?: string | null; frameTime?: number; view?: string; error?: string };

export default function usePanel(document: LayoutDocument, onOpen: (document: LayoutDocument, revision?: string) => void, isDirty: () => boolean, onInitialConflict: (document: LayoutDocument, revision: string) => void) {
  const [available, setAvailable] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);
  const [status, setStatus] = useState<PanelStatus>({});
  const [palette, setPalette] = useState<Palette | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewPending, setPreviewPending] = useState(false);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [previewMode, setPreviewMode] = useState<'sample' | 'live'>('sample');
  const [liveTick, setLiveTick] = useState(0);
  const previewRequest = useRef(false);
  const [stalePreview, setStalePreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openingSaved, setOpeningSaved] = useState(false);
  const [switching, setSwitching] = useState(false);
  const operation = useRef(false);
  const previewUrl = useRef<string | null>(null);
  const statusEpoch = useRef(0);
  const initial = useRef({ onOpen, isDirty, onInitialConflict });
  const text = serializeLayout(document);
  const previewKey = text + JSON.stringify(palette) + previewMode + (previewMode === 'live' ? liveTick : '');
  const renderedKey = useRef('');
  const renderedMode = useRef<'sample' | 'live'>('sample');
  const geometryKey = JSON.stringify(document.widgets.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })));
  const renderedGeometry = useRef('');

  useEffect(() => {
    let canceled = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let attempts = 0;
    async function connect() {
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 8000);
      try {
        const response = await fetch('/api/layout', { signal: controller.signal });
        if (response.status >= 500) throw new Error('Studio API is unavailable. Retrying automatically.');
        if (response.status === 404 || !response.headers.get('content-type')?.includes('application/json')) { if (!canceled) setConnectionError(''); return; }
        if (!response.ok) throw new Error('Studio API is unavailable. Retrying automatically.');
        let data: { document: unknown; revision: string }; let saved: LayoutDocument;
        try {
          data = await response.json(); saved = parseLayout(JSON.stringify(data.document));
          if (typeof data.revision !== 'string') throw new Error('Studio returned an invalid revision.');
        } catch (failure) { if (!canceled) setConnectionError(`The panel dashboard could not be read. ${failure instanceof Error ? failure.message : 'Check the saved configuration.'}`); return; }
        if (canceled) return;
        setAvailable(true); setRevision(data.revision); setConnectionError('');
        if (initial.current.isDirty()) initial.current.onInitialConflict(saved, data.revision);
        else initial.current.onOpen(saved, data.revision);
      } catch {
        if (!canceled) {
          setConnectionError('Studio API is unavailable. You can keep editing offline. Retrying automatically.');
          timer = window.setTimeout(() => void connect(), Math.min(15000, 3000 * 2 ** attempts++));
        }
      } finally { window.clearTimeout(timeout); }
    }
    void connect();
    return () => { canceled = true; window.clearTimeout(timer); controller?.abort(); };
  }, []);

  useEffect(() => {
    if (!available) return;
    let canceled = false;
    let pollSequence = 0;
    async function poll() {
      const epoch = statusEpoch.current;
      const sequence = ++pollSequence;
      try {
        const [stateResponse, paletteResponse] = await Promise.all([fetch('/api/status', { signal: AbortSignal.timeout(8000) }), fetch('/api/palette', { signal: AbortSignal.timeout(8000) })]);
        if (!stateResponse.ok) throw new Error('Studio server is unavailable.');
        const state = await stateResponse.json();
        const colors = paletteResponse.ok ? await paletteResponse.json() : null;
        if (!canceled && epoch === statusEpoch.current && sequence === pollSequence) { setStatus(state); setPalette((current) => JSON.stringify(current) === JSON.stringify(colors?.palette ?? null) ? current : colors?.palette ?? null); }
      } catch (error) {
        if (!canceled && epoch === statusEpoch.current && sequence === pollSequence) setStatus({ runtimeRunning: false, error: error instanceof Error ? error.message : 'Connection lost.' });
      }
    }
    void poll(); const timer = window.setInterval(() => void poll(), 1500);
    return () => { canceled = true; window.clearInterval(timer); };
  }, [available]);

  useEffect(() => {
    if (!available || previewMode !== 'live') return;
    const timer = window.setInterval(() => {
      if (!window.document.hidden && !previewRequest.current) setLiveTick((tick) => tick + 1);
    }, 2000);
    const visible = () => { if (!window.document.hidden) setLiveTick((tick) => tick + 1); };
    window.document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visible); };
  }, [available, previewMode]);

  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    previewRequest.current = true;
    setPreviewPending(true); setPreviewError(''); setStalePreview(false);
    const staleTimer = window.setTimeout(() => setStalePreview(true), 1500);
    const timeout = window.setTimeout(() => {
      controller.abort(); previewRequest.current = false; renderedKey.current = ''; setPreviewPending(false);
      setPreviewError('Panel preview timed out. Showing the local sample preview.');
    }, 8000);
    const timer = window.setTimeout(() => {
      void fetch(previewMode === 'live' ? '/api/preview?mode=live' : '/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text, signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) {
            const data = await response.json().catch(() => null);
            throw new Error(typeof data?.error === 'string' ? data.error.slice(0, 256) : 'Panel preview could not be rendered.');
          }
          if (!response.headers.get('content-type')?.includes('image/png')) throw new Error('Panel preview returned an invalid image.');
          const blob = await response.blob();
          if (!controller.signal.aborted) { previewRequest.current = false; window.clearTimeout(timeout); const url = URL.createObjectURL(blob); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = url; renderedKey.current = previewKey; renderedMode.current = previewMode; renderedGeometry.current = geometryKey; setPreview(url); setPreviewTime(Date.now()); setPreviewPending(false); setPreviewError(''); }
        }).catch((error) => { if (!controller.signal.aborted) { previewRequest.current = false; window.clearTimeout(timeout); renderedKey.current = ''; setPreviewError(`${error.message} Showing the local sample preview.`); setPreviewPending(false); } });
    }, 100);
    return () => { previewRequest.current = false; window.clearTimeout(timer); window.clearTimeout(timeout); window.clearTimeout(staleTimer); controller.abort(); };
  }, [available, text, palette, previewAttempt, previewMode, liveTick]);

  useEffect(() => () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); }, []);

  async function save(snapshot: LayoutDocument, expectedRevision: string | null = revision) {
    if (operation.current || !expectedRevision) return null;
    operation.current = true;
    setSaving(true);
    try {
      const response = await fetch('/api/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': expectedRevision }, body: serializeLayout(snapshot) });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && typeof data.revision === 'string') {
          setStatus((current) => ({ ...current, requestedRevision: data.revision }));
          throw new Error('The saved layout changed elsewhere. Your draft is intact. Review panel changes before replacing it.');
        }
        throw new Error(data.error ?? 'Could not save the layout.');
      }
      statusEpoch.current += 1;
      setRevision(data.revision);
      setStatus((current) => ({ ...current, requestedRevision: data.revision }));
      return data.revision as string;
    } finally { operation.current = false; setSaving(false); }
  }

  async function openSaved() {
    if (operation.current) throw new Error('Wait for the current panel operation to finish.');
    operation.current = true;
    setOpeningSaved(true);
    try {
      const response = await fetch('/api/layout');
      if (!response.ok) throw new Error('Could not open the saved layout.');
      const data = await response.json();
      return { document: parseLayout(JSON.stringify(data.document)), revision: data.revision as string };
    } finally { operation.current = false; setOpeningSaved(false); }
  }

  async function switchLayout(selection: LayoutSelection) {
    if (operation.current) return null;
    if (!revision) throw new Error('Open the saved panel layout before switching dashboards.');
    operation.current = true; setSwitching(true);
    try {
      const response = await fetch('/api/layouts/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': revision },
        body: JSON.stringify(selection),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && typeof data.revision === 'string') throw new Error('The panel layout changed elsewhere. Open the saved layout before switching again. Your draft is intact.');
        throw new Error(data.error ?? 'Could not switch the panel layout.');
      }
      if (typeof data.revision !== 'string' || typeof data.activeId !== 'string') throw new Error('Studio returned an invalid layout switch. Open the saved layout to check the panel.');
      const saved = parseLayout(JSON.stringify(data.document));
      adoptSaved(data.revision);
      return { document: saved, revision: data.revision as string, activeId: data.activeId as string };
    } finally { operation.current = false; setSwitching(false); }
  }

  function adoptSaved(savedRevision: string | null) {
    statusEpoch.current += 1;
    setRevision(savedRevision);
    setStatus((current) => ({ ...current, requestedRevision: savedRevision }));
  }

  return { available, revision, status, palette, previewMode, setPreviewMode, preview: renderedKey.current === previewKey || previewPending && !stalePreview && renderedMode.current === previewMode && renderedGeometry.current === geometryKey ? preview : null, previewError, previewPending, previewTime, connectionError, retryPreview: () => setPreviewAttempt((attempt) => attempt + 1), saving, openingSaved, switching, save, openSaved, switchLayout, adoptSaved };
}
