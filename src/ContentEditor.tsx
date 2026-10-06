import { useEffect, useState } from 'react';
import type { Widget } from './domain/layout';
import { gaugeStyles, storageStyles } from './domain/layout';
import { sourceLabels } from './domain/widgets';

const fieldLabels: Record<string, string> = {
  label: 'Label', value: 'Value', unit: 'Unit', detail: 'Detail', location: 'Location',
  temperature: 'Temperature', condition: 'Condition', high: 'High', low: 'Low',
  min: 'Minimum', max: 'Maximum', time: 'Time', date: 'Date', text: 'Text',
};

const styleLabels = { arc: 'Arc', ring: 'Ring', bar: 'Bar', segments: 'Segments', thermometer: 'Thermometer', number: 'Number' };

export function ContentField({ label, value, multiline = false, onCommit }: {
  label: string; value: string | number; multiline?: boolean; onCommit: (value: string | number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(String(value)); setError(''); }, [value]);
  function commit() {
    if (draft === String(value)) return;
    try {
      const number = Number(draft);
      if (typeof value === 'number' && (!draft.trim() || !Number.isFinite(number))) throw new Error('Enter a finite number.');
      onCommit(typeof value === 'number' ? number : draft);
      setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^.*settings\.[a-zA-Z]+: /, '') : 'Check this value.'); }
  }
  const props = {
    'aria-label': label, value: draft, 'aria-invalid': Boolean(error),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(event.target.value); setError(''); },
    onBlur: commit,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !multiline) { event.preventDefault(); commit(); }
      if (event.key === 'Escape') { event.stopPropagation(); setDraft(String(value)); setError(''); }
    },
  };
  return <label className="content-field">{label}<div className={`input-with-unit${error ? ' invalid' : ''}`}>
    {multiline ? <textarea {...props} rows={4} /> : <input {...props} inputMode={typeof value === 'number' ? 'decimal' : undefined} />}
  </div>{error && <span className="field-error" role="alert">{error}</span>}</label>;
}

export default function ContentEditor({ widget, onCommit }: { widget: Widget; onCommit: (patch: Record<string, unknown>) => void }) {
  const source = widget.type === 'text' ? 'sample' : widget.settings.source ?? 'sample';
  return <div className="inspector-section"><h4>Content</h4><div className="content-fields">
    {widget.type === 'storage' && <label className="source-field">Display style<select aria-label="Display style" value={widget.settings.style} onChange={(event) => onCommit({ style: event.target.value })}>{storageStyles.map((style) => <option key={style} value={style}>{style === 'bars' ? 'Usage bars' : 'Capacity table'}</option>)}</select></label>}
    {widget.type === 'gauge'  && <label className="source-field">Display style<select aria-label="Display style" value={widget.settings.style ?? 'arc'} onChange={(event) => { if (event.target.value !== (widget.settings.style ?? 'arc')) onCommit({ style: event.target.value }); }}>{gaugeStyles.map((style) => <option key={style} value={style}>{styleLabels[style]}</option>)}</select></label>}
    {Object.entries(widget.settings).filter(([key]) => !['source', 'format', 'showDate', 'style'].includes(key)).map(([key, value]) =>
      <ContentField key={key} label={fieldLabels[key]} value={value as string | number} multiline={key === 'text'} onCommit={(next) => onCommit({ [key]: next })} />)}
    {widget.type === 'clock' && <>
      <fieldset className="clock-format"><legend>Time format</legend>{(['24h', '12h'] as const).map((format) => <label key={format}><input type="radio" name="clock-format" checked={widget.settings.format === format} onChange={() => onCommit({ format })} />{format === '24h' ? '24-hour' : '12-hour'}</label>)}</fieldset>
      <label className="theme-choice"><input type="checkbox" checked={widget.settings.showDate} onChange={(event) => onCommit({ showDate: event.target.checked })} />Show date</label>
    </>}
  </div>{source !== 'sample' && <p className="panel-note">On the panel, {sourceLabels[source]} fills {widget.type === 'storage' ? 'the mounted filesystem list' : widget.type === 'clock' ? 'the time and date' : widget.type === 'weather' ? 'the forecast' : 'the value, unit and detail'}. These sample values appear in the offline preview.</p>}</div>;
}
