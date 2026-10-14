import type { Widget } from './domain/layout';
import { resolveElements } from './domain/design';
import './movement-styles.css';

export default function MovementControls({ widget, count, element, onTarget, onNudge, busy }: {
  widget?: Widget; count: number; element: string | null; busy: boolean;
  onTarget: (element: string | null) => void; onNudge: (dx: number, dy: number) => void;
}) {
  const elements = widget && count === 1 ? resolveElements(widget) : [];
  const target = elements.find((entry) => entry.id === element);
  const offsets = element ? widget?.design?.elements?.[element] : undefined;
  return <div className="movement-controls" data-movement-controls tabIndex={0} role="group" aria-label="Precise movement">
    <div className="movement-targets" role="group" aria-label="Arrows move">
      <span>Arrows move</span>
      <button disabled={!widget || busy} aria-pressed={!element} onClick={() => onTarget(null)}>{count > 1 ? `${count} cards` : 'Card'}</button>
      {elements.map((entry) => <button key={entry.id} disabled={entry.hidden || busy} title={entry.hidden ? `${entry.name} is hidden. Show it in Design first.` : `Move ${entry.name.toLowerCase()}`} aria-pressed={entry.id === element} onClick={() => onTarget(entry.id)}>{entry.name}</button>)}
    </div>
    <div className="movement-readout mono" aria-live="polite" aria-atomic="true">{target ? `${target.name} / X offset ${offsets?.dx ?? 0} / Y offset ${offsets?.dy ?? 0}` : widget ? `X ${widget.x} / Y ${widget.y}` : 'Select a card to move'}</div>
    <p className="movement-help">Arrows 1 px. Shift 10 px.{elements.length > 0 && ' Enter selects an element. Esc returns to card.'} Space-drag pans.</p>
    <div className="movement-nudges" role="group" aria-label="Nudge selection">
      {([['left', '←', -1, 0], ['up', '↑', 0, -1], ['down', '↓', 0, 1], ['right', '→', 1, 0]] as const).map(([direction, glyph, dx, dy]) => <button key={direction} data-nudge-button disabled={!widget || busy} aria-label={`Nudge ${direction}`} title={`Move ${direction} 1 px, Shift for 10 px`} onClick={(event) => onNudge(dx * (event.shiftKey ? 10 : 1), dy * (event.shiftKey ? 10 : 1))}>{glyph}</button>)}
    </div>
  </div>;
}
