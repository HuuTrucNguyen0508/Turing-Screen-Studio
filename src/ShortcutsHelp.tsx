import { Popover } from './Menu';

const shortcuts: [string[], string][] = [
  [['←', '↑', '↓', '→'], 'Move the selection 1 px'],
  [['Shift', 'Arrow'], 'Move 10 px'],
  [['Shift', 'Click'], 'Add or remove a card from the selection'],
  [['Ctrl', 'A'], 'Select all cards'],
  [['Ctrl', 'C'], 'Copy selected cards to the clipboard'],
  [['Ctrl', 'X'], 'Cut selected cards'],
  [['Ctrl', 'V'], 'Paste the newest copy'],
  [['Ctrl', 'Z'], 'Undo'],
  [['Ctrl', 'Shift', 'Z'], 'Redo, also Ctrl Y'],
  [['Enter'], 'Move a clock’s time instead of the card'],
  [['Esc'], 'Back to the card, or cancel a drag'],
  [['Double-click'], 'Select a clock label, time or date'],
  [['Space', 'Drag'], 'Pan the canvas, also middle-drag'],
];

export default function ShortcutsHelp({ panel }: { panel: boolean }) {
  return <Popover className="shortcuts-help" title="Keyboard shortcuts" buttonLabel="Keyboard shortcuts" label="?">
    {(close) => <>
      <div className="popover-heading"><h2>Keyboard shortcuts</h2><button className="panel-close" aria-label="Close keyboard shortcuts" onClick={close}>×</button></div>
      <dl className="shortcut-list">
        {shortcuts.map(([keys, action]) => <div key={action}><dt>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt><dd>{action}</dd></div>)}
        {panel && <div><dt><kbd>Ctrl</kbd><kbd>F9</kbd>–<kbd>F12</kbd></dt><dd>Show saved layout 1 to 4 on the panel</dd></div>}
      </dl>
      <p className="popover-note">Shortcuts work when focus is outside text fields. On a Mac, use Cmd for Ctrl.</p>
    </>}
  </Popover>;
}
