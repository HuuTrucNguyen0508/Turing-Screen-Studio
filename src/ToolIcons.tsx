import type { Alignment, LayerDirection } from './domain/canvas';

export function AlignmentIcon({ mode }: { mode: Alignment }) {
  const horizontal = ['left', 'center', 'right'].includes(mode);
  const line = mode === 'left' || mode === 'top' ? 2 : mode === 'right' || mode === 'bottom' ? 14 : 8;
  const first = line === 2 ? 4 : line === 14 ? 2 : 3;
  const second = line === 2 ? 4 : line === 14 ? 6 : 5;
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d={horizontal ? `M${line} 1v14` : `M1 ${line}h14`} stroke="currentColor" />
    {horizontal ? <><rect x={first} y="4" width="10" height="3" fill="currentColor" /><rect x={second} y="9" width="6" height="3" fill="currentColor" /></>
      : <><rect x="4" y={first} width="3" height="10" fill="currentColor" /><rect x="9" y={second} width="3" height="6" fill="currentColor" /></>}
  </svg>;
}

export function LayerIcon({ direction }: { direction: LayerDirection }) {
  const up = direction === 'forward' || direction === 'front';
  const limit = direction === 'front' || direction === 'back';
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d={up ? 'M8 13V5M4.5 8.5 8 5l3.5 3.5' : 'M8 3v8M4.5 7.5 8 11l3.5-3.5'} />
    {limit && <path d={up ? 'M3 2.5h10' : 'M3 13.5h10'} />}
  </svg>;
}
