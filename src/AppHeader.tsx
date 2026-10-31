import type { ReactNode, Ref } from 'react';
import ContentField from './ContentField';
import { Menu } from './Menu';
import type { MenuEntry } from './Menu';
import type { DraftTarget } from './domain/draft';

export default function AppHeader({ name, target, status, dirty, canUndo, canRedo, panel, library, layoutMenu, settingsMenu, settingsRef, actions, onRename, onUndo, onRedo, onShutdown }: {
  name: string; target: DraftTarget; status: string; dirty: boolean; canUndo: boolean; canRedo: boolean;
  /** Panel connection summary; detail explains it on hover. */
  panel: { available: boolean; state: string; detail: string };
  library: ReactNode; layoutMenu: MenuEntry[]; settingsMenu: MenuEntry[]; settingsRef: Ref<HTMLButtonElement>; actions: ReactNode;
  onRename: (value: string) => void; onUndo: () => void; onRedo: () => void;
  onShutdown: () => void;
}) {
  const origin = target.kind === 'library' ? `Library entry ${target.entryName}` : target.kind === 'archive' ? 'History draft' : null;
  return <header className="app-header">
    <a className="brand" href="#" onClick={(event) => event.preventDefault()} aria-label="TURZX Studio"><span className="brand-symbol" aria-hidden="true">T</span></a>
    <div className="document-title">
      <h1 className="visually-hidden">{name}</h1>
      <ContentField label="Layout name" value={name} onCommit={(value) => { if (!String(value).trim()) throw new Error('Enter a layout name.'); onRename(String(value)); }} />
      <div className="document-meta">
        {origin && <span className="document-origin" title={origin}>{origin}</span>}
        <span className={`document-status${dirty ? ' dirty' : ''}`} data-testid="document-status">{status}</span>
      </div>
    </div>
    {library}
    <div className="edit-history" role="group" aria-label="Edit history">
      <button aria-label="Undo" aria-keyshortcuts="Control+Z Meta+Z" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M5.5 3 2.5 6l3 3M3 6h6.5a4 4 0 0 1 0 8H7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button aria-label="Redo" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M10.5 3l3 3-3 3M13 6H6.5a4 4 0 0 0 0 8H9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </div>
    <div className="header-end">
      <span className={`panel-status${panel.available ? '' : ' offline'}`} role={panel.available ? 'status' : undefined} title={panel.detail}><span className="status-dot" aria-hidden="true" />{panel.state}</span>
      <Menu label="Layout" items={layoutMenu} />
      <Menu label="Settings" className="settings-menu" items={panel.available ? [...settingsMenu, 'separator', { label: 'Shut down Studio…', destructive: true, onSelect: onShutdown }] : settingsMenu} triggerRef={settingsRef} />
      <div className="header-actions">{actions}</div>
    </div>
  </header>;
}
