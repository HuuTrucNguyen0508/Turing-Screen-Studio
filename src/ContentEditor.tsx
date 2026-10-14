import type { Widget } from './domain/layout';
import { gaugeStyles, storageStyles } from './domain/layout';
import { sourceLabels } from './domain/widgets';
import { isDashboardSource } from './domain/dashboardData';
import { trendGeometry, trendSources } from './domain/trend';
import InspectorSection from './InspectorSection';
import { CalendarEditor, GraphEditor, ListEditor } from './ListGraphCalendarEditor';
import ContentField from './ContentField';

const fieldLabels: Record<string, string> = {
  label: 'Label', value: 'Value', unit: 'Unit', detail: 'Detail', location: 'Location',
  temperature: 'Temperature', condition: 'Condition', high: 'High', low: 'Low',
  min: 'Minimum', max: 'Maximum', time: 'Time', date: 'Date', text: 'Text',
  opacity: 'Opacity (%)',
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

type EditorProps = { widget: Widget; onCommit: (patch: Record<string, unknown>) => void };

export default function ContentEditor({ widget, onCommit }: EditorProps) {
  let content;
  switch (widget.type) {
    case 'list': content = <ListEditor widget={widget} onCommit={onCommit} />; break;
    case 'graph': content = <GraphEditor widget={widget} onCommit={onCommit} />; break;
    case 'calendar': content = <CalendarEditor widget={widget} onCommit={onCommit} />; break;
    default: content = <StandardContentEditor widget={widget} onCommit={onCommit} />;
  }
  return <InspectorSection id="content" title="Content">{content}</InspectorSection>;
}

function StandardContentEditor({ widget, onCommit }: { widget: Exclude<Widget, { type: 'list' | 'graph' | 'calendar' }>; onCommit: EditorProps['onCommit'] }) {
  const source = widget.type === 'text' || widget.type === 'image' ? 'sample' : widget.settings.source ?? 'sample';
  const fields = Object.entries(widget.settings).filter(([key]) => !controlledSettings.includes(key) && (!isDashboardSource(source) || key === 'label'));
  const replaced = source !== 'sample' && !isDashboardSource(source) ? liveReplacedFields[widget.type] ?? [] : [];
  const field = ([key, value]: [string, unknown]) => <ContentField key={key} label={fieldLabels[key]} value={value as string | number} multiline={key === 'text'} onCommit={(next) => onCommit({ [key]: next })} />;
  return <><div className="content-fields">
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
  </>;
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
