import { useEffect, useRef, useState } from 'react';
import type { LayoutDocument, Palette, PaletteColorKey, Widget } from './domain/layout';
import { paletteColorKeys } from './domain/layout';
import { effectiveWidgetPalette, updateWidgetColor } from './domain/colors';
import { colorPresets, defaultStudioTheme } from './domain/studioTheme';
import type { StudioThemePreference } from './domain/studioTheme';
import ColorField from './ColorField';
import './color-styles.css';

const labels: Record<PaletteColorKey, string> = {
  background: 'Background', surface: 'Surface', surfaceRaised: 'Raised surface', text: 'Text',
  muted: 'Secondary text', primary: 'Primary accent', secondary: 'Secondary accent', outline: 'Border',
};
const widgetLabels: Record<PaletteColorKey, string> = { ...labels, background: 'Background color', surface: 'Card background', surfaceRaised: 'Track background', primary: 'Value and chart', secondary: 'Secondary accent' };

function PaletteFields({ palette, prefix, onChange }: { palette: Palette; prefix: string; onChange: (key: PaletteColorKey, color: string) => void }) {
  return <div className="palette-fields">{paletteColorKeys.map((key) => <ColorField key={key} label={`${prefix} ${labels[key].toLowerCase()}`} value={palette[key]} onChange={(color) => onChange(key, color)} />)}</div>;
}

function Presets({ onChoose, scope }: { onChoose: (palette: Palette) => void; scope: string }) {
  return <div className="color-presets" role="group" aria-label={`${scope} color presets`}>{colorPresets.map((palette) => <button key={palette.name} aria-label={`Use ${palette.name} for ${scope}`} onClick={() => onChoose({ ...palette })}>
    <span className="color-preset-swatches" aria-hidden="true">{(['background', 'surface', 'text', 'primary'] as const).map((key) => <span key={key} style={{ background: palette[key] }} />)}</span>{palette.name}
  </button>)}</div>;
}

export function WidgetColorEditor({ document, widget, palette, onChange }: {
  document: LayoutDocument; widget: Widget; palette: Palette; onChange: (next: LayoutDocument) => void;
}) {
  const effective = effectiveWidgetPalette(palette, widget);
  return <details className="inspector-section widget-colors">
    <summary><h4>Colors</h4><span className="mono">{widget.colors ? 'Custom' : 'From dashboard'}</span></summary>
    <p className="panel-note">Each color starts from the dashboard palette. Reset a color to follow it again.{widget.type === 'image' && ' Embedded image pixels keep their original colors.'}</p>
    <div className="widget-color-fields">{paletteColorKeys.map((key) => <ColorField key={key} label={widgetLabels[key]} value={effective[key]} inherited={!Object.hasOwn(widget.colors ?? {}, key)}
      onChange={(color) => onChange(updateWidgetColor(document, widget.id, key, color))}
      onReset={() => onChange(updateWidgetColor(document, widget.id, key, null))} />)}</div>
    <button className="text-button" disabled={!widget.colors} onClick={() => onChange({ ...document, widgets: document.widgets.map((entry) => {
      if (entry.id !== widget.id) return entry;
      const copy = { ...entry }; delete copy.colors; return copy;
    }) })}>Reset widget colors</button>
  </details>;
}

export default function ColorEditor({ initialTab, document, dashboardPalette, studioPalette, desktopAvailable, preference, storageError, onStudioChange, onDashboardChange, onImport, onClose }: {
  initialTab: 'studio' | 'dashboard'; document: LayoutDocument; dashboardPalette: Palette; studioPalette: Palette; desktopAvailable: boolean;
  preference: StudioThemePreference; storageError: string;
  onStudioChange: (preference: StudioThemePreference) => void; onDashboardChange: (document: LayoutDocument) => void;
  onImport: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState(initialTab);
  useEffect(() => { dialog.current?.showModal(); }, []);
  function savePalette(palette: Palette) { onDashboardChange({ ...document, palette: { ...palette }, paletteMode: 'saved' }); }
  return <dialog ref={dialog} className="catalog-dialog color-dialog" aria-labelledby="color-dialog-title" onCancel={onClose} onClose={onClose}>
    <div className="panel-heading"><h2 id="color-dialog-title">Colors</h2><button aria-label="Close colors" onClick={onClose}>×</button></div>
    <div className="color-tabs" role="group" aria-label="Color settings"><button aria-pressed={tab === 'studio'} onClick={() => setTab('studio')}>Studio</button><button aria-pressed={tab === 'dashboard'} onClick={() => setTab('dashboard')}>Dashboard</button></div>
    {tab === 'studio' ? <section aria-label="Studio colors">
      <p>Choose how the editor looks. Studio colors are remembered in this browser.</p>
      <label className="color-source">Studio color source<select aria-label="Studio color source" value={preference.mode} onChange={(event) => onStudioChange({ ...preference, mode: event.target.value as StudioThemePreference['mode'], ...(event.target.value === 'custom' ? { palette: { ...studioPalette } } : {}) })}>
        <option value="dashboard">Match dashboard</option><option value="desktop" disabled={!desktopAvailable}>Follow desktop{!desktopAvailable ? ' (unavailable)' : ''}</option><option value="custom">Custom Studio colors</option>
      </select></label>
      <Presets scope="Studio" onChoose={(palette) => onStudioChange({ mode: 'custom', palette })} />
      <p className="panel-note">Editing a color switches Studio to custom colors.</p>
      <PaletteFields prefix="Studio" palette={studioPalette} onChange={(key, color) => onStudioChange({ mode: 'custom', palette: { ...studioPalette, name: 'Custom Studio', [key]: color } })} />
      <button className="text-button" onClick={() => onStudioChange(defaultStudioTheme())}>Reset Studio appearance</button>
      {storageError && <p className="field-error" role="status">{storageError}</p>}
    </section> : <section aria-label="Dashboard colors">
      <p>Set the canvas and default widget colors. These colors travel with exported layouts and support Undo.</p>
      <label className="theme-choice"><input type="checkbox" disabled={!desktopAvailable} checked={document.paletteMode === 'live'} onChange={(event) => event.target.checked
        ? onDashboardChange({ ...document, paletteMode: 'live' }) : savePalette(dashboardPalette)} />Follow desktop colors{!desktopAvailable && <span className="panel-note">Desktop sync is unavailable. Saved colors still work.</span>}</label>
      <Presets scope="dashboard" onChoose={savePalette} />
      <p className="panel-note">Editing a color uses a saved palette and stops desktop sync for this dashboard.</p>
      <PaletteFields prefix="Dashboard" palette={dashboardPalette} onChange={(key, color) => savePalette({ ...dashboardPalette, name: 'Custom dashboard', [key]: color })} />
      <div className="color-footer-actions"><button onClick={onImport}>Import scheme.json</button><button className="text-button" onClick={() => savePalette(colorPresets[0])}>Reset dashboard palette</button></div>
    </section>}
    <div className="color-done"><button className="primary-button" onClick={onClose}>Done</button></div>
  </dialog>;
}
