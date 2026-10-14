import { ContentField } from './ContentEditor';
import type { CalendarWidget, GraphWidget, ListRow, ListWidget, SensorSource } from './domain/layout';
import { graphStyles } from './domain/layout';
import { LIST_MAX_ROWS, listSampleRow } from './domain/list';
import { sensorShortLabels } from './domain/cardText';
import { trendSources } from './domain/trend';
import { sourceLabels } from './domain/widgets';
import './card-editor-styles.css';

type Commit = (patch: Record<string, unknown>) => void;

function ListEditor({ widget, onCommit }: { widget: ListWidget; onCommit: Commit }) {
  const { rows } = widget.settings;
  const setRows = (next: ListRow[]) => onCommit({ rows: next });
  const unused = trendSources.filter((source) => !rows.some((row) => row.source === source));
  const move = (index: number, offset: number) => {
    const next = [...rows];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    setRows(next);
  };
  return <>
    <ol className="card-rows" aria-label="Rows">{rows.map((row, index) => <li key={row.source} className="card-row" data-row-source={row.source}>
      <div className="card-row-heading"><span>Row {index + 1}</span><div className="card-row-actions">
        <button type="button" aria-label={`Move ${row.label || sensorShortLabels[row.source]} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
        <button type="button" aria-label={`Move ${row.label || sensorShortLabels[row.source]} down`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}>↓</button>
        <button type="button" aria-label={`Remove ${row.label || sensorShortLabels[row.source]}`} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, other) => other !== index))}>Remove</button>
      </div></div>
      <label className="source-field">Sensor<select aria-label={`Row ${index + 1} sensor`} value={row.source} onChange={(event) => {
        const source = event.target.value as SensorSource;
        const sample = listSampleRow(source);
        // A label the user wrote stays; the default name follows the sensor.
        const label = row.label.trim() && row.label !== sensorShortLabels[row.source] ? row.label : sample.label;
        setRows(rows.map((entry, other) => other === index ? { ...sample, label } : entry));
      }}>{[row.source, ...unused].map((source) => <option key={source} value={source}>{sourceLabels[source]}</option>)}</select></label>
      <ContentField label={`Row ${index + 1} label`} value={row.label} onCommit={(value) => setRows(rows.map((entry, other) => other === index ? { ...entry, label: String(value) } : entry))} />
      <div className="card-row-sample">
        <ContentField label={`Row ${index + 1} sample value`} value={row.value} onCommit={(value) => setRows(rows.map((entry, other) => other === index ? { ...entry, value: String(value) } : entry))} />
        <ContentField label={`Row ${index + 1} unit`} value={row.unit} onCommit={(value) => setRows(rows.map((entry, other) => other === index ? { ...entry, unit: String(value) } : entry))} />
      </div>
    </li>)}</ol>
    <button type="button" className="card-add-row" disabled={rows.length >= LIST_MAX_ROWS || !unused.length} onClick={() => setRows([...rows, listSampleRow(unused[0])])}>Add row</button>
    <label className="theme-choice"><input type="checkbox" checked={widget.settings.bars} onChange={(event) => onCommit({ bars: event.target.checked })} />Show bars</label>
    <p className="panel-note">Up to {LIST_MAX_ROWS} sensors. Bars show percentages and temperatures from 0 to 100 °C; network rows have none. The panel shows live readings.</p>
  </>;
}

function GraphEditor({ widget, onCommit }: { widget: GraphWidget; onCommit: Commit }) {
  const [first, second] = widget.settings.sources;
  return <>
    <fieldset className="clock-format"><legend>Chart style</legend>{graphStyles.map((style) => <label key={style}><input type="radio" name={`graph-style-${widget.id}`} checked={widget.settings.style === style} onChange={() => onCommit({ style })} />{style === 'area' ? 'Area' : 'Line'}</label>)}</fieldset>
    <label className="source-field">First series<select aria-label="First series" value={first} onChange={(event) => onCommit({ sources: second ? [event.target.value, second] : [event.target.value] })}>
      {trendSources.filter((source) => source !== second).map((source) => <option key={source} value={source}>{sourceLabels[source]}</option>)}</select></label>
    <label className="source-field">Second series<select aria-label="Second series" value={second ?? ''} onChange={(event) => onCommit({ sources: event.target.value ? [first, event.target.value] : [first] })}>
      <option value="">None</option>{trendSources.filter((source) => source !== first).map((source) => <option key={source} value={source}>{sourceLabels[source]}</option>)}</select></label>
    <p className="panel-note">Series with the same unit share one scale. The preview uses demo history; the panel draws its last 120 readings.</p>
  </>;
}

function CalendarEditor({ widget, onCommit }: { widget: CalendarWidget; onCommit: Commit }) {
  return <>
    <label className="source-field">Week starts on<select aria-label="Week starts on" value={widget.settings.weekStart} onChange={(event) => onCommit({ weekStart: event.target.value })}>
      <option value="monday">Monday</option><option value="sunday">Sunday</option></select></label>
    <p className="panel-note">The preview shows 6 October 2026. {widget.settings.source === 'clock' ? 'On the panel, the panel clock sets the month and today.' : 'Choose Panel clock above to follow the panel date.'}</p>
  </>;
}

export default function ListGraphCalendarEditor({ widget, onCommit }: { widget: ListWidget | GraphWidget | CalendarWidget; onCommit: Commit }) {
  return <div className="inspector-section"><h4>Content</h4><div className="content-fields">
    <ContentField label="Label" value={widget.settings.label} onCommit={(value) => onCommit({ label: value })} />
    {widget.type === 'list' && <ListEditor widget={widget} onCommit={onCommit} />}
    {widget.type === 'graph' && <GraphEditor widget={widget} onCommit={onCommit} />}
    {widget.type === 'calendar' && <CalendarEditor widget={widget} onCommit={onCommit} />}
  </div></div>;
}
