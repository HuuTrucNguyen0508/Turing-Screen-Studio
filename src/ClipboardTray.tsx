import { Popover } from './Menu';
import { StaticLayout } from './WidgetContent';
import { clipPreview, clipType } from './domain/clipboard';
import type { ClipEntry } from './domain/clipboard';
import type { Palette } from './domain/layout';

const typeNames: Record<string, string> = { metric: 'Metric', weather: 'Weather', clock: 'Clock', text: 'Text', gauge: 'Gauge', storage: 'Storage', image: 'Image' };

export function clipDescription(clip: ClipEntry): string {
  const type = clipType(clip);
  return type === 'group' ? `${clip.widgets.length} cards` : typeNames[type];
}

function copiedAt(time: number) {
  const date = new Date(time);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(undefined, { timeStyle: 'short' })
    : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export default function ClipboardTray({ entries, error, palette, busy, open, onOpenChange, onPaste, onForget, onClear, onKeep }: {
  entries: readonly ClipEntry[]; error: string; palette: Palette; busy: boolean; open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaste: (clip: ClipEntry) => void; onForget: (clip: ClipEntry) => void; onClear: () => void; onKeep: (clip: ClipEntry) => void;
}) {
  return <Popover className="clipboard-tray" title="Clipboard" open={open} onOpenChange={onOpenChange}
    buttonLabel={`Clipboard, ${entries.length} ${entries.length === 1 ? 'copy' : 'copies'}`}
    label={<>Clipboard{entries.length > 0 && <span className="count-badge" aria-hidden="true">{entries.length}</span>}</>}>
    {(close) => <>
      <div className="popover-heading"><h2>Clipboard</h2><button className="panel-close" aria-label="Close clipboard" onClick={close}>×</button></div>
      <p className="popover-note">Copies stay in this browser, so you can open another layout and paste them there. Save as custom widget keeps one in Add widget for good.</p>
      {error && <p className="popover-error" role="status">{error}</p>}
      {entries.length === 0 ? <p className="clipboard-empty">Nothing copied yet. Select a card and choose Copy, or press <kbd>Ctrl</kbd> <kbd>C</kbd>.</p>
        : <ol className="clipboard-list">{entries.map((clip, index) => <li key={clip.id}>
          <div className="clipboard-thumb"><StaticLayout document={clipPreview(clip, palette)} maxWidth={92} maxHeight={58} /></div>
          <div className="clipboard-info">
            <strong title={clip.name}>{clip.name}</strong>
            <span>{clipDescription(clip)} from {clip.source || 'an untitled layout'}, {copiedAt(clip.copiedAt)}</span>
            {index === 0 && <span className="clipboard-next">Ctrl+V pastes this one</span>}
            <div className="clipboard-actions">
              <button className={index === 0 ? 'primary-button' : undefined} disabled={busy} aria-label={`Paste ${clip.name}`} onClick={() => onPaste(clip)}>Paste</button>
              {clip.widgets.length === 1 && <button disabled={busy} aria-label={`Save ${clip.name} as custom widget`} onClick={() => onKeep(clip)}>Save as custom widget…</button>}
              <button aria-label={`Remove ${clip.name} from clipboard`} onClick={() => onForget(clip)}>Remove</button>
            </div>
          </div>
        </li>)}</ol>}
      {entries.length > 0 && <div className="clipboard-footer"><span>Keeps the last 12 copies.</span><button onClick={onClear}>Clear clipboard</button></div>}
    </>}
  </Popover>;
}
