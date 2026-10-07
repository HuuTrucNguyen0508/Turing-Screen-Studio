import { describe, expect, it } from 'vitest';
import { createSampleLayout, serializeLayout, validateLayout } from './layout';
import { resizeCanvas } from './canvasSize';

describe('canvas size', () => {
  it('fits cards uniformly into a portrait canvas while preserving IDs and content', () => {
    const original = createSampleLayout();
    const before = serializeLayout(original);
    const next = resizeCanvas(original, 320, 480, 'fit');
    expect(next.canvas).toEqual({ width: 320, height: 480 });
    expect(next.widgets.map(widget => widget.id)).toEqual(original.widgets.map(widget => widget.id));
    expect(next.widgets.map(widget => widget.settings)).toEqual(original.widgets.map(widget => widget.settings));
    next.widgets.forEach(widget => {
      expect([widget.x, widget.y, widget.width, widget.height].every(Number.isInteger)).toBe(true);
      expect(widget.x + widget.width).toBeLessThanOrEqual(320);
      expect(widget.y + widget.height).toBeLessThanOrEqual(480);
    });
    expect(validateLayout(next)).toEqual(next);
    expect(serializeLayout(original)).toBe(before);
  });
  it('keeps positions on a larger canvas and rejects a crop without mutating the document', () => {
    const original = createSampleLayout();
    expect(resizeCanvas(original, 1920, 1080, 'keep').widgets).toEqual(original.widgets);
    expect(() => resizeCanvas(original, 320, 480, 'keep')).toThrow('outside the canvas');
    expect(original.canvas).toEqual({ width: 1280, height: 800 });
  });
  it('maps shared edges identically and keeps collapsed one-pixel cards in bounds', () => {
    const sample = createSampleLayout();
    const base = sample.widgets[0];
    const original = { ...sample, canvas: { width: 100, height: 100 }, widgets: [
      { ...base, id: 'left', x: 0, y: 0, width: 33, height: 100 },
      { ...base, id: 'right', x: 33, y: 0, width: 67, height: 100 },
      { ...base, id: 'edge', x: 99, y: 99, width: 1, height: 1 },
    ] };
    const next = resizeCanvas(original, 37, 37, 'fit');
    expect(next.widgets[0].x + next.widgets[0].width).toBe(next.widgets[1].x);
    expect(next.widgets[1].x + next.widgets[1].width).toBe(37);
    expect(next.widgets[2]).toMatchObject({ x: 36, y: 36, width: 1, height: 1 });
    expect(validateLayout(next)).toEqual(next);
  });
  it('preserves metadata and clears cards even when dimensions stay the same', () => {
    const original = createSampleLayout();
    const next = resizeCanvas(original, 1280, 800, 'empty');
    expect(next).toEqual({ ...validateLayout(original), widgets: [] });
    const fitted = resizeCanvas(original, 800, 480, 'fit');
    expect({ ...fitted, canvas: original.canvas, widgets: original.widgets }).toEqual(validateLayout(original));
  });
  it('rejects invalid sizes, unsupported modes and oversized preview allocations', () => {
    const original = createSampleLayout();
    for (const width of [0, -1, 1.5, NaN, Infinity, 16385])
      expect(() => resizeCanvas(original, width, 800, 'fit')).toThrow('whole pixel');
    expect(() => resizeCanvas(original, 5000, 5000, 'fit')).toThrow('16 million');
    expect(() => resizeCanvas(original, 800, 800, 'other' as 'fit')).toThrow('Choose');
  });
});
