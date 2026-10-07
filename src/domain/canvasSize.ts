import { validateLayout, type LayoutDocument } from './layout';

export type CanvasResizeMode = 'fit' | 'keep' | 'empty';

/** Resize a draft with integer geometry. Widget content and IDs stay intact. */
export function resizeCanvas(document: LayoutDocument, width: number, height: number, mode: CanvasResizeMode): LayoutDocument {
  const current = validateLayout(document);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384)
    throw new Error('Use whole pixel dimensions from 1 to 16384.');
  if (width * height > 16_000_000) throw new Error('Use a canvas of at most 16 million pixels for image previews.');
  if (mode !== 'fit' && mode !== 'keep' && mode !== 'empty') throw new Error('Choose how to resize the cards.');
  if (width === current.canvas.width && height === current.canvas.height && mode !== 'empty') return current;
  // One rational scale preserves aspect ratio. Map shared edges with the same
  // integer expression so touching cards remain touching after rounding.
  const widthLimited = width * current.canvas.height <= height * current.canvas.width;
  const numerator = widthLimited ? width : height;
  const denominator = widthLimited ? current.canvas.width : current.canvas.height;
  function edges(position: number, length: number, oldSize: number, newSize: number) {
    const map = (value: number) => Math.floor((2 * value * numerator + newSize * denominator - oldSize * numerator + denominator) / (2 * denominator));
    const start = Math.max(0, Math.min(newSize - 1, map(position)));
    const end = Math.min(newSize, Math.max(start + 1, map(position + length)));
    return [start, end - start];
  }
  const widgets = mode === 'empty' ? [] : current.widgets.map(widget => {
    if (mode === 'keep') {
      if (widget.x + widget.width > width || widget.y + widget.height > height)
        throw new Error('Some cards would be outside the canvas. Choose Fit cards or move them first.');
      return widget;
    }
    const [x, cardWidth] = edges(widget.x, widget.width, current.canvas.width, width);
    const [y, cardHeight] = edges(widget.y, widget.height, current.canvas.height, height);
    return { ...widget, x, y, width: cardWidth, height: cardHeight };
  });
  return validateLayout({ ...current, canvas: { width, height }, widgets });
}
