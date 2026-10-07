import { useEffect, useId, useRef, useState } from 'react';

export default function ColorField({ label, value, onChange, onReset, inherited = false }: {
  label: string; value: string; onChange: (color: string) => void; onReset?: () => void; inherited?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const edited = useRef(false);
  useEffect(() => { setDraft(value); setError(''); edited.current = false; }, [value]);
  function commit(explicit = false) {
    const color = draft.trim();
    if (!/^#[0-9a-f]{6}$/i.test(color)) { setError('Use a six-digit hex color, such as #9bd0d1.'); return; }
    setError(''); setDraft(color.toLowerCase());
    if (explicit || edited.current || color.toLowerCase() !== value.toLowerCase()) onChange(color.toLowerCase());
    edited.current = false;
  }
  return <div className="color-field">
    <label htmlFor={id}>{label}{onReset && <small>{inherited ? 'From dashboard' : 'Custom'}</small>}</label>
    <div className="color-field-controls">
      <input type="color" aria-label={`${label} color picker`} value={value} onChange={(event) => { setDraft(event.target.value); setError(''); onChange(event.target.value); }} />
      <input id={id} aria-label={`${label} hex`} className="color-hex" value={draft} spellCheck={false} autoComplete="off" maxLength={7}
        aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => { setDraft(event.target.value); setError(''); edited.current = true; }} onBlur={() => commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit(true); }
          if (event.key === 'Escape' && (draft !== value || error)) { event.preventDefault(); event.stopPropagation(); setDraft(value); setError(''); edited.current = false; }
        }} />
      {onReset && <button className="color-reset" aria-label={`Reset ${label} color`} disabled={inherited} onClick={onReset}>Reset</button>}
    </div>
    {error && <span id={`${id}-error`} className="field-error" role="alert">{error}</span>}
  </div>;
}
