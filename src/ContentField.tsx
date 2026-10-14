import { useEffect, useState } from 'react';

export default function ContentField({ label, value, multiline = false, onCommit }: {
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
      const inputType = 'inputType' in event.nativeEvent ? event.nativeEvent.inputType : undefined;
      if (numeric && !inputType) commit(event.target.value);
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
