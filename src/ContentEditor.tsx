import { useEffect, useState } from 'react';
import type { Widget } from './domain/layout';
import { gaugeStyles, storageStyles } from './domain/layout';
import { sourceLabels } from './domain/widgets';
import { isDashboardSource } from './domain/dashboardData';
import { trendGeometry, trendSources } from './domain/trend';
import InspectorSection from './InspectorSection';
import ListGraphCalendarEditor from './ListGraphCalendarEditor';

const fieldLabels: Record<string, string> = {
  label: 'Label', value: 'Value', unit: 'Unit', detail: 'Detail', location: 'Location',
  temperature: 'Temperature', condition: 'Condition', high: 'High', low: 'Low',
  min: 'Minimum', max: 'Maximum', time: 'Time', date: 'Date', text: 'Text',
  opacity: 'Opacity (%)', rows: 'Rows', bars: 'Bars', sources: 'Series', weekStart: 'Week start',
};

const styleLabels = { arc: 'Arc', ring: 'Ring', bar: 'Bar', segments: 'Segments', thermometer: 'Thermometer', number: 'Number' };

// Settings with their own controls, or none at all, never render as text fields.
const controlledSettings = ['source', 'format', 'showDate', 'style', 'grouping', 'mounts', 'data', 'fit', 'trend'];

// Fields a live source replaces on the panel (see runtime rendered_content); they only feed the offline preview.
const liveReplacedFields: Partial<Record<Widget['type'], readonly string[]>> = {
  metric: ['value', 'unit', 'detail'],
  gauge: ['value', 'unit', 'detail'],
  weather: ['location', 'temperature', 'unit', 'condition', 'high', 'low'],
  clock: ['time', 'date'],
};

export function ContentField({ label, value, multiline = false, onCommit }: {
  label: string; value: string | number; multiline?: boolean; onCommit: (value: string | number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(String(value)); setError(''); }, [value]);
  const numeric = typeof value === 'number';
  function commit(next = draft) {
    if (next === String(value)) return;
    try {
      const number = Number(next);
      if (numeric && (!next.trim() || !Number.isFinite(number))) throw new Error('Enter a finite number.');
      onCommit(numeric ? number : next);
      setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^.*settings\.[a-zA-Z]+: /, '') : 'Check this value.'); }
  }
  const props = {
    'aria-label': label, value: draft, 'aria-invalid': Boolean(error),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(event.target.value); setError('');
      // Typing arrives as an InputEvent and waits for Enter or blur; spinner and arrow-key steps commit at once.
      if (numeric && !(event.nativeEvent instanceof InputEvent)) commit(event.target.value);
    },
    onBlur: () => commit(),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !multiline) { event.preventDefault(); commit(); }
      if (event.key === 'Escape') { event.stopPropagation(); setDraft(String(value)); setError(''); }
    },
  };
  return <label className="content-field">{label}<div className={`input-with-unit${error ? ' invalid' : ''}`}>
    {multiline ? <textarea {...props} rows={4} /> : <input {...props} type={numeric ? 'number' : 'text'} step={numeric ? 'any' : undefined} />}
  </div>{error && <span className="field-error" role="alert">{error}</span>}</label>;
}

export default function ContentEditor({ widget, onCommit }: { widget: Widget; onCommit: (patch: Record<string, unknown>) => void }) {
  if (widget.type === 'list' || widget.type === 'graph' || widget.type === 'calendar') return <ListGraphCalendarEditor widget={widget} onCommit={onCommit} />;
  const source = widget.type === 'text' || widget.type === 'image' ? 'sample' : widget.settings.source ?? 'sample';
  const fields = Object.entries(widget.settings).filter(([key]) => !controlledSettings.includes(key) && (!isDashboardSource(source) || key === 'label'));
  const replaced = source !== 'sample' && !isDashboardSource(source) ? liveReplacedFields[widget.type] ?? [] : [];
  const field = ([key, value]: [string, unknown]) => <ContentField key={key} label={fieldLabels[key]} value={value as string | number} multiline={key === 'text'} onCommit={(next) => onCommit({ [key]: next })} />;
  return <InspectorSection id="content" title="Content"><div className="content-fields">
    {widget.type === 'image' && <label className="source-field">Image fit<select aria-label="Image fit" value={widget.settings.fit} onChange={(event) => onCommit({ fit: event.target.value })}><option value="contain">Contain</option><option value="cover">Cover</option><option value="stretch">Stretch</option></select></label>}
    {widget.type === 'storage' && <label className="source-field">Display style<select aria-label="Display style" value={widget.settings.style} onChange={(event) => onCommit({ style: event.target.value })}>{storageStyles.map((style) => <option key={style} value={style}>{style === 'bars' ? 'Usage bars' : 'Capacity table'}</option>)}</select></label>}
    {widget.type === 'storage' && <><label className="source-field">Storage view<select aria-label="Storage view" value={widget.settings.grouping ?? 'partitions'} onChange={(event) => onCommit({ grouping: event.target.value, ...(event.target.value === 'drives' ? { mounts: undefined } : {}) })}><option value="drives">Physical drives</option><option value="partitions">Partitions</option></select></label>
      {widget.settings.grouping !== 'drives' && <><ContentField label="Mount paths" value={widget.settings.mounts?.join('\n') ?? ''} multiline onCommit={(value) => { const mounts = String(value).split('\n').map((path) => path.trim()).filter(Boolean); onCommit({ mounts: mounts.length ? mounts : undefined }); }} /><p className="panel-note">One absolute path per line, in display order. Leave blank for every mounted partition.</p></>}
    </>}
    {widget.type === 'gauge' && <label className="source-field">Display style<select aria-label="Display style" value={widget.settings.style ?? 'arc'} onChange={(event) => { if (event.target.value !== (widget.settings.style ?? 'arc')) onCommit({ style: event.target.value }); }}>{gaugeStyles.map((style) => <option key={style} value={style}>{styleLabels[style]}</option>)}</select></label>}
    {widget.type === 'metric' && <TrendControl widget={widget} source={source} onCommit={onCommit} />}
    {fields.filter(([key]) => !replaced.includes(key)).map(field)}
    {widget.type === 'clock' && <>
      <fieldset className="clock-format"><legend>Time format</legend>{(['24h', '12h'] as const).map((format) => <label key={format}><input type="radio" name="clock-format" checked={widget.settings.format === format} onChange={() => onCommit({ format })} />{format === '24h' ? '24-hour' : '12-hour'}</label>)}</fieldset>
      <label className="theme-choice"><input type="checkbox" checked={widget.settings.showDate} onChange={(event) => onCommit({ showDate: event.target.checked })} />Show date</label>
    </>}
  </div>
    {replaced.length > 0 && <details className="sample-values">
      <summary>Sample values (preview only)</summary>
      <p className="panel-note">On the panel, {sourceLabels[source]} replaces these.</p>
      <div className="content-fields">{fields.filter(([key]) => replaced.includes(key)).map(field)}</div>
    </details>}
    {isDashboardSource(source) && <p className="panel-note">{source === 'game-resources' ? 'Game timers are shared across dashboards. Set a count after playing to correct the estimate.' : 'T3 threads show local active work. Stale or unavailable activity stays unknown.'}</p>}
  </InspectorSection>;
}

function TrendControl({ widget, source, onCommit }: { widget: Extract<Widget, { type: 'metric' }>; source: string; onCommit: (patch: Record<string, unknown>) => void }) {
  const on = widget.settings.trend === true;
  const supported = source === 'sample' || (trendSources as readonly string[]).includes(source);
  const note = !supported ? 'Trend needs a CPU, GPU, memory, disk, network or temperature source.'
    : on && !trendGeometry(widget.width, widget.height).showChart ? 'The chart appears when the card is at least 160 × 216 px.' : '';
  return <div>
    <label className="theme-choice"><input type="checkbox" checked={on} disabled={!supported && !on} aria-describedby={note ? `trend-note-${widget.id}` : undefined}
      onChange={(event) => onCommit({ trend: event.target.checked ? true : undefined })} />Trend chart</label>
    {note && <p id={`trend-note-${widget.id}`} className="panel-note">{note}</p>}
  </div>;
}
