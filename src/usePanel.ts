import { useEffect, useRef, useState } from 'react';
import { parseLayout, serializeLayout } from './domain/layout';
import type { LayoutDocument, Palette } from './domain/layout';

export type PanelStatus = { runtimeRunning?: boolean; connected?: boolean; usbPresent?: boolean; appliedRevision?: string | null; requestedRevision?: string | null; frameRevision?: string | null; frameTime?: number; view?: string; error?: string };

export default function usePanel(document: LayoutDocument, onOpen: (document: LayoutDocument, revision?: string) => void, isDirty: () => boolean, onInitialConflict: (document: LayoutDocument, revision: string) => void) {
  const [available, setAvailable] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);
  const [status, setStatus] = useState<PanelStatus>({});
  const [palette, setPalette] = useState<Palette | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [openingSaved, setOpeningSaved] = useState(false);
  const previewUrl = useRef<string | null>(null);
  const statusEpoch = useRef(0);
  const initial = useRef({ onOpen, isDirty, onInitialConflict });
  const text = serializeLayout(document);

  useEffect(() => {
    let canceled = false;
    void fetch('/api/layout').then(async (response) => {
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
      const data = await response.json();
      const saved = parseLayout(JSON.stringify(data.document));
      if (canceled) return;
      setAvailable(true);
      if (initial.current.isDirty()) initial.current.onInitialConflict(saved, data.revision);
      else initial.current.onOpen(saved, data.revision);
    }).catch(() => {});
    return () => { canceled = true; };
  }, []);

  useEffect(() => {
    if (!available) return;
    let canceled = false;
    let pollSequence = 0;
    async function poll() {
      const epoch = statusEpoch.current;
      const sequence = ++pollSequence;
      try {
        const [stateResponse, paletteResponse] = await Promise.all([fetch('/api/status'), fetch('/api/palette')]);
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
    if (!available) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text, signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('Panel preview could not be rendered.');
          const blob = await response.blob();
          if (!controller.signal.aborted) { const url = URL.createObjectURL(blob); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = url; setPreview(url); setPreviewError(''); }
        }).catch((error) => { if (!controller.signal.aborted) setPreviewError(error.message); });
    }, 100);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [available, text, palette]);

  useEffect(() => () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); }, []);

  async function save(snapshot: LayoutDocument) {
    if (saving || openingSaved || !revision) return null;
    setSaving(true);
    try {
      const response = await fetch('/api/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': revision }, body: serializeLayout(snapshot) });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          throw new Error('The saved layout changed elsewhere. Your draft is intact. Open the saved layout to compare before saving again.');
        }
        throw new Error(data.error ?? 'Could not save the layout.');
      }
      statusEpoch.current += 1;
      setRevision(data.revision);
      setStatus((current) => ({ ...current, requestedRevision: data.revision }));
      return data.revision as string;
    } finally { setSaving(false); }
  }

  async function openSaved() {
    setOpeningSaved(true);
    try {
      const response = await fetch('/api/layout');
      if (!response.ok) throw new Error('Could not open the saved layout.');
      const data = await response.json();
      return { document: parseLayout(JSON.stringify(data.document)), revision: data.revision as string };
    } finally { setOpeningSaved(false); }
  }

  function adoptSaved(savedRevision: string) {
    statusEpoch.current += 1;
    setRevision(savedRevision);
    setStatus((current) => ({ ...current, requestedRevision: savedRevision }));
  }

  return { available, revision, status, palette, preview, previewError, saving, openingSaved, save, openSaved, adoptSaved };
}
