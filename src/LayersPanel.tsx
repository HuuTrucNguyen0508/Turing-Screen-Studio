import { widgetLabel } from './WidgetContent';
import { sourceLabels } from './domain/widgets';
import type { LayoutDocument, Palette } from './domain/layout';

const icons = { metric: '▤', weather: '☀', clock: '◷', text: '¶', gauge: '◔', storage: '▣', image: '▧', list: '☷', graph: '⌁', calendar: '▦' };

export default function LayersPanel({ document, selectedIds, palette, busy, onSelect, onSelectAll, onColors, onHide, hidden }: {
  document: LayoutDocument; selectedIds: readonly string[]; palette: Palette; busy: boolean;
  onSelect: (id: string, toggle: boolean) => void; onSelectAll: () => void; onColors: () => void; onHide: () => void; hidden: boolean;
}) {
  return <aside id="layers-panel" className="layers-panel side-panel" aria-label="Layers" tabIndex={-1} hidden={hidden}>
    <div className="side-heading">
      <h2>Layers <span className="count-badge">{document.widgets.length}</span></h2>
      <button className="text-link" disabled={busy || !document.widgets.length} onClick={onSelectAll} aria-keyshortcuts="Control+A Meta+A">Select all</button>
      <button className="panel-close" aria-label="Hide Layers" aria-expanded="true" aria-controls="layers-panel" disabled={busy} onClick={onHide}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14"><path d="M8.5 3 4.5 7l4 4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
    </div>
    <div className="widget-list" aria-label="Layers, front to back">{[...document.widgets].reverse().map((widget) => <button key={widget.id}
      className={`widget-row${selectedIds.includes(widget.id) ? ' active' : ''}`}
      data-widget-row={widget.id} aria-pressed={selectedIds.includes(widget.id)} onClick={(event) => onSelect(widget.id, event.shiftKey)}>
      <span className="widget-icon" aria-hidden="true">{icons[widget.type]}</span>
      <span><strong>{widgetLabel(widget)}</strong><small>{widget.type}{widget.type === 'text' || widget.type === 'image' || widget.type === 'list' || widget.type === 'graph' ? '' : `, ${sourceLabels[widget.settings.source ?? 'sample'].toLowerCase()}`}</small></span>
    </button>)}</div>
    {document.widgets.length === 0 && <p className="panel-note">This canvas is empty. Add a widget, paste from the clipboard, or create a layout from a preset.</p>}
    <button className="palette-button" onClick={onColors} aria-label={`Dashboard colors, ${palette.name}${document.paletteMode === 'live' ? ', following the desktop' : ''}`}>
      <span className="swatches" aria-hidden="true">{(['background', 'surface', 'primary', 'secondary', 'text'] as const).map((key) => <span key={key} style={{ background: palette[key] }} />)}</span>
      <span><strong>Dashboard colors</strong><small>{document.paletteMode === 'live' ? 'Following the desktop' : palette.name}</small></span>
    </button>
  </aside>;
}
