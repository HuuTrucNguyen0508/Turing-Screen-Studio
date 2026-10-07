import { describe, expect, it } from 'vitest';
import { createSampleLayout, serializeLayout, validateLayout } from './layout';
import type { LayoutDocument } from './layout';
import {
  alignSelection, canvasWarnings, distributeSelection, matchSelectionSize, moveSelection,
  reorderSelection, selectionBounds, selectionIds, snapResize, snapSelection,
} from './canvas';

type Card = readonly [id: string, x: number, y: number, width: number, height: number];
function scene(cards: readonly Card[], width = 1000, height = 600): LayoutDocument {
  return validateLayout({
    ...createSampleLayout(), canvas: { width, height },
    widgets: cards.map(([id, x, y, width, height]) => ({
      id, type: 'text', x, y, width, height, settings: { label: id, text: id },
    })),
  });
}
function freezeDeep(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeDeep(child);
  Object.freeze(value);
}
function order(doc: LayoutDocument): string[] { return doc.widgets.map((widget) => widget.id); }
function positions(doc: LayoutDocument): number[][] { return doc.widgets.map(({ x, y }) => [x, y]); }

describe('selection and group movement', () => {
  const cards: Card[] = [['a', 10, 20, 100, 60], ['b', 240, 180, 120, 100], ['c', 850, 400, 150, 200]];

  it('deduplicates stale IDs and uses paint order regardless of requested order', () => {
    const doc = scene(cards);
    const ids = Object.freeze(['c', 'missing', 'a', 'c']);
    expect(selectionIds(doc, ids)).toEqual(['a', 'c']);
    expect(selectionBounds(doc, ids)).toEqual({ x: 10, y: 20, width: 990, height: 580 });
    expect(ids).toEqual(['c', 'missing', 'a', 'c']);
    expect(selectionIds(doc, [])).toEqual([]);
    expect(selectionBounds(doc, ['missing'])).toBeNull();
    expect(selectionBounds(scene([]), ['a'])).toBeNull();
  });

  it('clamps the whole group on all boundaries without changing its shape', () => {
    const doc = scene(cards);
    freezeDeep(doc);
    const left = moveSelection(doc, ['a', 'b'], -500, -500);
    expect(positions(left)).toEqual([[0, 0], [230, 160], [850, 400]]);
    const right = moveSelection(doc, ['b', 'a'], 5000, 5000);
    expect(positions(right)).toEqual([[650, 340], [880, 500], [850, 400]]);
    expect(validateLayout(left)).toEqual(left);
    expect(validateLayout(right)).toEqual(right);
    expect(positions(doc)).toEqual(cards.map(([, x, y]) => [x, y]));
  });

  it('keeps identity for empty selections, zero motion, and clamped no-ops', () => {
    const doc = scene(cards);
    expect(moveSelection(doc, [], 17, 23)).toBe(doc);
    expect(moveSelection(doc, ['unknown'], 17, 23)).toBe(doc);
    expect(moveSelection(doc, ['a'], 0, 0)).toBe(doc);
    expect(moveSelection(doc, ['c'], 1, 1)).toBe(doc);
    expect(moveSelection(doc, ['a', 'c'], 1, 1)).toBe(doc);
  });

  it('clamps safe extreme deltas before addition and rejects invalid numbers even on empty selections', () => {
    const doc = scene(cards);
    const moved = moveSelection(doc, ['a', 'b'], Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER);
    expect(positions(moved)).toEqual([[650, 0], [880, 160], [850, 400]]);
    for (const value of [0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => moveSelection(doc, [], value, 0)).toThrow('safe integer');
      expect(() => moveSelection(doc, ['a'], 0, value)).toThrow('safe integer');
    }
  });

  it('round-trips group movement and preserves unselected cards, dimensions, settings and paint order', () => {
    const doc = scene(cards);
    const moved = moveSelection(doc, ['a', 'b'], 31, 47);
    expect(moveSelection(moved, ['b', 'a'], -31, -47)).toEqual(doc);
    expect(order(moved)).toEqual(order(doc));
    expect(moved.widgets[2]).toEqual(doc.widgets[2]);
    for (let index = 0; index < doc.widgets.length; index++) {
      expect(moved.widgets[index].settings).toEqual(doc.widgets[index].settings);
      expect(moved.widgets[index].width).toBe(doc.widgets[index].width);
      expect(moved.widgets[index].height).toBe(doc.widgets[index].height);
    }
  });
});

describe('alignment', () => {
  const cards: Card[] = [['a', 13, 17, 100, 60], ['b', 220, 182, 81, 81], ['c', 600, 400, 120, 100]];

  it.each([
    ['left', [[13, 17], [13, 182]]],
    ['center', [[107, 17], [117, 182]]],
    ['right', [[201, 17], [220, 182]]],
    ['top', [[13, 17], [220, 17]]],
    ['middle', [[13, 110], [220, 100]]],
    ['bottom', [[13, 203], [220, 182]]],
  ] as const)('aligns %s against a single original group bounds with integer rounding', (mode, expected) => {
    const doc = scene(cards);
    freezeDeep(doc);
    const aligned = alignSelection(doc, ['b', 'a', 'b'], mode);
    expect(positions(aligned)).toEqual([...expected, [600, 400]]);
    expect(validateLayout(aligned)).toEqual(aligned);
    if (mode !== 'center' && mode !== 'middle') expect(alignSelection(aligned, ['a', 'b'], mode)).toBe(aligned);
    expect(positions(doc)).toEqual([[13, 17], [220, 182], [600, 400]]);
  });

  it('keeps alignment in bounds when the group touches both canvas edges', () => {
    const doc = scene([['a', 0, 0, 1, 1], ['b', 999, 599, 1, 1], ['c', 700, 100, 300, 500]]);
    for (const mode of ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const) {
      const aligned = alignSelection(doc, order(doc), mode);
      expect(validateLayout(aligned)).toEqual(aligned);
    }
    expect(alignSelection(doc, ['a'], 'center')).toBe(doc);
    expect(alignSelection(doc, [], 'bottom')).toBe(doc);
  });
});

describe('matching selection sizes', () => {
  it.each([
    ['width', [[81, 60], [81, 81], [120, 100]]],
    ['height', [[100, 81], [81, 81], [120, 100]]],
    ['both', [[81, 81], [81, 81], [120, 100]]],
  ] as const)('matches %s using the specified reference rather than selection or paint order', (mode, expected) => {
    const doc = scene([['a', 13, 17, 100, 60], ['b', 220, 182, 81, 81], ['c', 600, 400, 120, 100]]);
    const before = serializeLayout(doc);
    freezeDeep(doc);
    const ids = Object.freeze(['a', 'missing', 'b', 'a']);
    const matched = matchSelectionSize(doc, ids, 'b', mode);
    expect(matched.widgets.map(({ width, height }) => [width, height])).toEqual(expected);
    expect(positions(matched)).toEqual(positions(doc));
    expect(order(matched)).toEqual(order(doc));
    expect(matched.widgets.map(({ settings }) => settings)).toEqual(doc.widgets.map(({ settings }) => settings));
    expect(matched.widgets[2]).toEqual(doc.widgets[2]);
    expect(validateLayout(matched)).toEqual(matched);
    expect(matchSelectionSize(matched, ids, 'b', mode)).toBe(matched);
    expect(serializeLayout(doc)).toBe(before);
  });

  it('retains identity for missing/unselected references and fewer than two normalized IDs', () => {
    const doc = scene([['a', 0, 0, 100, 60], ['b', 200, 100, 120, 80], ['c', 400, 200, 150, 90]]);
    for (const mode of ['width', 'height', 'both'] as const) {
      for (const ids of [[], ['missing'], ['a'], ['a', 'a', 'missing']]) {
        expect(matchSelectionSize(doc, ids, 'a', mode)).toBe(doc);
      }
      expect(matchSelectionSize(doc, ['a', 'b'], 'missing', mode)).toBe(doc);
      expect(matchSelectionSize(doc, ['a', 'b'], 'c', mode)).toBe(doc);
      const same = scene([['a', 0, 0, 100, 60], ['b', 200, 100, 100, 60]]);
      expect(matchSelectionSize(same, ['b', 'a'], 'a', mode)).toBe(same);
    }
  });

  it.each(['width', 'height', 'both'] as const)('rejects %s overflow atomically without shifting or clamping', (mode) => {
    const doc = scene([
      ['first', 0, 0, 100, 60], ['reference', 200, 100, 200, 100],
      ['overflow', mode === 'height' ? 0 : 850, mode === 'width' ? 0 : 550, 100, 50],
    ]);
    const before = serializeLayout(doc);
    freezeDeep(doc);
    expect(() => matchSelectionSize(doc, order(doc), 'reference', mode)).toThrow('Widget "overflow"');
    expect(() => matchSelectionSize(doc, order(doc), 'reference', mode)).toThrow('outside the canvas');
    expect(serializeLayout(doc)).toBe(before);
  });

  it('allows exact edge fits and ignores overflow on an unmatched axis', () => {
    const doc = scene([['reference', 0, 0, 200, 100], ['target', 800, 550, 100, 50]]);
    expect(matchSelectionSize(doc, order(doc), 'reference', 'width').widgets[1]).toMatchObject({ width: 200, height: 50, x: 800, y: 550 });
    const vertical = scene([['reference', 0, 0, 200, 100], ['target', 900, 500, 100, 50]]);
    expect(matchSelectionSize(vertical, order(vertical), 'reference', 'height').widgets[1]).toMatchObject({ width: 100, height: 100, x: 900, y: 500 });
  });
});

describe('distribution', () => {
  it('uses cumulative rounding for unequal widths and retains the original outer edges', () => {
    const doc = scene([
      ['last', 301, 70, 100, 60], ['first', 10, 10, 100, 60],
      ['third', 220, 90, 81, 60], ['second', 120, 50, 60, 60], ['untouched', 800, 200, 120, 60],
    ]);
    freezeDeep(doc);
    const spread = distributeSelection(doc, ['second', 'third', 'first', 'last'], 'horizontal');
    expect(positions(spread)).toEqual([[301, 70], [10, 10], [203, 90], [127, 50], [800, 200]]);
    expect(selectionBounds(spread, order(doc).slice(0, 4))).toEqual(selectionBounds(doc, order(doc).slice(0, 4)));
    expect(order(spread)).toEqual(order(doc));
    expect(validateLayout(spread)).toEqual(spread);
  });

  it('distributes vertically, with stable paint order for tied starting positions', () => {
    const doc = scene([['a', 10, 10, 100, 60], ['b', 210, 10, 100, 80], ['c', 400, 221, 100, 100]]);
    const spread = distributeSelection(doc, ['c', 'b', 'a'], 'vertical');
    expect(positions(spread)).toEqual([[10, 10], [210, 106], [400, 221]]);
    expect(order(spread)).toEqual(['a', 'b', 'c']);
    expect(validateLayout(spread)).toEqual(spread);
  });

  it('uses two cards for an explicit gap and shifts the row inward when necessary', () => {
    const doc = scene([['a', 750, 10, 100, 60], ['b', 800, 100, 200, 60]]);
    expect(distributeSelection(doc, ['a', 'b'], 'horizontal')).toBe(doc);
    const spread = distributeSelection(doc, ['b', 'a'], 'horizontal', 24);
    expect(positions(spread)).toEqual([[676, 10], [800, 100]]);
    expect(spread.widgets[1].x - spread.widgets[0].x - spread.widgets[0].width).toBe(24);
    expect(validateLayout(spread)).toEqual(spread);
    expect(distributeSelection(spread, ['a', 'b'], 'horizontal', 24)).toBe(spread);
  });

  it('places explicit vertical gaps from the minimum start, including zero gaps and exact fits', () => {
    const doc = scene([['a', 0, 50, 120, 60], ['b', 200, 50, 120, 80], ['c', 400, 400, 120, 100]]);
    expect(positions(distributeSelection(doc, order(doc), 'vertical', 24))).toEqual([[0, 50], [200, 134], [400, 238]]);
    expect(positions(distributeSelection(doc, order(doc), 'vertical', 0))).toEqual([[0, 50], [200, 110], [400, 190]]);
    const exact = distributeSelection(doc, order(doc), 'vertical', 180);
    expect(positions(exact)).toEqual([[0, 0], [200, 240], [400, 500]]);
  });

  it('rejects impossible spans and invalid gaps without changing the original snapshot', () => {
    const doc = scene([['a', 0, 0, 600, 60], ['b', 400, 100, 600, 60]]);
    const before = serializeLayout(doc);
    freezeDeep(doc);
    expect(() => distributeSelection(doc, order(doc), 'horizontal', 24)).toThrow('does not fit');
    const fitting = scene([['a', 0, 0, 100, 60], ['b', 500, 100, 100, 60]]);
    expect(() => distributeSelection(fitting, order(fitting), 'horizontal', 801)).toThrow('does not fit');
    expect(() => distributeSelection(fitting, order(fitting), 'horizontal', Number.MAX_SAFE_INTEGER)).toThrow('does not fit');
    for (const gap of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => distributeSelection(doc, [], 'vertical', gap)).toThrow('nonnegative safe integer');
    }
    expect(serializeLayout(doc)).toBe(before);
    expect(distributeSelection(doc, ['a'], 'horizontal', 24)).toBe(doc);
    expect(distributeSelection(doc, ['unknown'], 'vertical')).toBe(doc);
  });

  it('allows overlapping selections with negative equal gaps when their distributed positions fit', () => {
    const doc = scene([['a', 0, 0, 150, 60], ['b', 25, 100, 150, 60], ['c', 100, 200, 150, 60]]);
    const spread = distributeSelection(doc, order(doc), 'horizontal');
    expect(positions(spread)).toEqual([[0, 0], [50, 100], [100, 200]]);
    expect(validateLayout(spread)).toEqual(spread);
  });
});

describe('layer order', () => {
  const cards: Card[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => [id, index * 100, 10, 100, 60]);

  it.each([
    ['front', ['a', 'd', 'f', 'b', 'c', 'e']],
    ['back', ['b', 'c', 'e', 'a', 'd', 'f']],
    ['forward', ['a', 'd', 'b', 'c', 'f', 'e']],
    ['backward', ['b', 'c', 'a', 'e', 'd', 'f']],
  ] as const)('moves %s while preserving selected and unselected paint order', (direction, expected) => {
    const doc = scene(cards);
    freezeDeep(doc);
    const changed = reorderSelection(doc, ['e', 'c', 'b', 'c', 'missing'], direction);
    expect(order(changed)).toEqual(expected);
    expect(selectionIds(changed, ['e', 'b', 'c'])).toEqual(['b', 'c', 'e']);
    expect(changed.widgets.map((widget) => widget.id).sort()).toEqual(order(doc));
    for (const widget of changed.widgets) expect(widget).toEqual(doc.widgets.find(({ id }) => id === widget.id));
    expect(order(doc)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('does not jump over selected members at the front/back limits', () => {
    const doc = scene(cards);
    expect(order(reorderSelection(doc, ['b', 'f'], 'forward'))).toEqual(['a', 'c', 'b', 'd', 'e', 'f']);
    expect(order(reorderSelection(doc, ['a', 'e'], 'backward'))).toEqual(['a', 'b', 'c', 'e', 'd', 'f']);
    expect(reorderSelection(doc, ['f'], 'forward')).toBe(doc);
    expect(reorderSelection(doc, ['a'], 'backward')).toBe(doc);
    expect(reorderSelection(doc, ['unknown'], 'front')).toBe(doc);
    for (const direction of ['front', 'back', 'forward', 'backward'] as const) {
      expect(reorderSelection(doc, order(doc), direction)).toBe(doc);
    }
  });
});

describe('group snapping', () => {
  it('snaps to widget gutters at the inclusive threshold and leaves distant movement alone', () => {
    const doc = scene([['moving', 40, 110, 100, 60], ['target', 300, 310, 100, 60]]);
    expect(snapSelection(doc, ['moving'], 130, 0)).toEqual({ dx: 136, dy: 0, guides: [{ axis: 'x', position: 276 }] });
    expect(snapSelection(doc, ['moving'], 129, 0)).toEqual({ dx: 129, dy: 0, guides: [] });
    expect(snapSelection(doc, ['moving'], 140, 0, 3)).toEqual({ dx: 140, dy: 0, guides: [] });
    expect(snapSelection(doc, ['moving'], 140, 0, 4)).toEqual({ dx: 136, dy: 0, guides: [{ axis: 'x', position: 276 }] });
  });

  it('snaps to the nearest edge or center, including canvas gutters, with deterministic ties', () => {
    const doc = scene([['moving', 100, 110, 100, 60], ['target', 300, 310, 120, 60]]);
    expect(snapSelection(doc, ['moving'], 198, 0)).toEqual({ dx: 200, dy: 0, guides: [{ axis: 'x', position: 300 }] });
    expect(snapSelection(doc, ['moving'], 207, 0)).toEqual({ dx: 210, dy: 0, guides: [{ axis: 'x', position: 360 }] });
    expect(snapSelection(doc, ['moving'], -98, 0)).toEqual({ dx: -100, dy: 0, guides: [{ axis: 'x', position: 0 }] });
    expect(snapSelection(doc, ['moving'], -73, 0)).toEqual({ dx: -76, dy: 0, guides: [{ axis: 'x', position: 24 }] });
    expect(snapSelection(doc, ['moving'], 348, 0)).toEqual({ dx: 350, dy: 0, guides: [{ axis: 'x', position: 500 }] });
    const tie = scene([['moving', 100, 100, 100, 60], ['first', 300, 300, 120, 60], ['second', 308, 400, 120, 60]]);
    expect(snapSelection(tie, ['moving'], 204, 0).dx).toBe(200);
  });

  it('uses selection bounds, ignores selected members as targets and preserves the group shape', () => {
    const doc = scene([['a', 50, 50, 100, 60], ['b', 250, 150, 100, 60], ['target', 600, 400, 120, 60]]);
    freezeDeep(doc);
    const snap = snapSelection(doc, ['b', 'a'], 222, 185);
    expect(snap).toEqual({ dx: 226, dy: 190, guides: [{ axis: 'x', position: 576 }, { axis: 'y', position: 400 }] });
    const moved = moveSelection(doc, ['a', 'b'], snap.dx, snap.dy);
    expect(positions(moved)).toEqual([[276, 240], [476, 340], [600, 400]]);
    expect(moved.widgets[1].x - moved.widgets[0].x).toBe(200);
    expect(moved.widgets[1].y - moved.widgets[0].y).toBe(100);
    const self = scene([['a', 100, 100, 120, 60], ['b', 244, 300, 120, 60]]);
    expect(snapSelection(self, order(self), 3, 3)).toEqual({ dx: 3, dy: 3, guides: [] });
    expect(positions(doc)).toEqual([[50, 50], [250, 150], [600, 400]]);
  });

  it('rounds center matches to integer displacements and keeps guides on the target center', () => {
    const doc = scene([['a', 100, 100, 81, 61]], 1000, 600);
    expect(snapSelection(doc, ['a'], 358, 168)).toEqual({ dx: 360, dy: 170, guides: [{ axis: 'x', position: 500 }, { axis: 'y', position: 300 }] });
    expect(validateLayout(moveSelection(doc, ['a'], 360, 170))).toMatchObject({ widgets: [{ x: 460, y: 270 }] });
    expect(snapSelection(doc, ['a'], 360, 170, 0)).toEqual({ dx: 360, dy: 170, guides: [] });
  });

  it('clamps huge requests and rejects snap candidates that would push any member outside', () => {
    const doc = scene([['a', 850, 450, 150, 150], ['target', 850, 200, 120, 60]]);
    expect(snapSelection(doc, ['a'], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toEqual({
      dx: 0, dy: 0, guides: [{ axis: 'x', position: 1000 }, { axis: 'y', position: 600 }],
    });
    const nearEdge = scene([['a', 845, 100, 150, 60], ['target', 853, 350, 120, 60]]);
    expect(snapSelection(nearEdge, ['a'], 4, 0).dx).toBe(5);
    const snap = snapSelection(doc, ['a'], -Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER);
    expect(validateLayout(moveSelection(doc, ['a'], snap.dx, snap.dy))).toEqual(moveSelection(doc, ['a'], snap.dx, snap.dy));
  });

  it('has an empty result for empty or stale IDs and rejects invalid snap settings', () => {
    const doc = scene([]);
    expect(snapSelection(doc, ['missing'], 12, 34)).toEqual({ dx: 0, dy: 0, guides: [] });
    for (const value of [0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => snapSelection(doc, [], value, 0)).toThrow('dx');
      expect(() => snapSelection(doc, [], 0, value)).toThrow('dy');
      expect(() => snapSelection(doc, [], 0, 0, value)).toThrow('threshold');
      expect(() => snapSelection(doc, [], 0, 0, 6, value)).toThrow('gutter');
    }
    expect(() => snapSelection(doc, [], 0, 0, -1)).toThrow('threshold');
    expect(() => snapSelection(doc, [], 0, 0, 6, -1)).toThrow('gutter');
  });

  it('preserves shape and valid integer geometry across all boundary directions', () => {
    const doc = scene([['a', 1, 2, 181, 93], ['b', 400, 300, 220, 100], ['c', 740, 499, 259, 101]]);
    freezeDeep(doc);
    for (const ids of [['a', 'b'], ['b', 'c'], ['a', 'c'], order(doc)]) {
      for (const dx of [-Number.MAX_SAFE_INTEGER, -37, 0, 37, Number.MAX_SAFE_INTEGER]) {
        for (const dy of [-Number.MAX_SAFE_INTEGER, -29, 0, 29, Number.MAX_SAFE_INTEGER]) {
          const snapped = snapSelection(doc, ids, dx, dy);
          expect(Number.isSafeInteger(snapped.dx) && Number.isSafeInteger(snapped.dy)).toBe(true);
          const moved = moveSelection(doc, ids, snapped.dx, snapped.dy);
          expect(validateLayout(moved)).toEqual(moved);
          for (const id of ids) {
            const before = doc.widgets.find((widget) => widget.id === id)!;
            const after = moved.widgets.find((widget) => widget.id === id)!;
            expect(after.x - before.x).toBe(snapped.dx);
            expect(after.y - before.y).toBe(snapped.dy);
          }
          expect(snapped.guides.every(({ axis, position }) => position >= 0 && position <= doc.canvas[axis === 'x' ? 'width' : 'height'])).toBe(true);
        }
      }
    }
  });
});

describe('resize snapping', () => {
  it.each([
    [894, 444, 900, 450, 1000, 600],
    [870, 420, 876, 426, 976, 576],
  ])('snaps to canvas edges and inner gutters at the inclusive threshold', (width, height, expectedWidth, expectedHeight, x, y) => {
    const doc = scene([['a', 100, 150, 100, 60]]);
    expect(snapResize(doc, 'a', width, height)).toEqual({ width: expectedWidth, height: expectedHeight,
      guides: [{ axis: 'x', position: x }, { axis: 'y', position: y }] });
    expect(snapResize(doc, 'a', width - 1, height - 1)).toEqual({ width: width - 1, height: height - 1, guides: [] });
  });

  it('includes both inner gutters even on small positive dimensions', () => {
    const doc = scene([['a', 0, 0, 100, 60]]);
    expect(snapResize(doc, 'a', 20, 28)).toEqual({ width: 24, height: 24,
      guides: [{ axis: 'x', position: 24 }, { axis: 'y', position: 24 }] });
  });

  it.each([
    [196, 156, 200, 160, 300, 310],
    [317, 257, 320, 260, 420, 410],
    [170, 130, 176, 136, 276, 286],
    [341, 281, 344, 284, 444, 434],
    [116, 104, 120, 100, 220, 250],
  ])('snaps independently to other edges, gutters and matching dimensions', (width, height, expectedWidth, expectedHeight, x, y) => {
    const doc = scene([['a', 100, 150, 80, 60], ['other', 300, 310, 120, 100]]);
    freezeDeep(doc);
    expect(snapResize(doc, 'a', width, height)).toEqual({ width: expectedWidth, height: expectedHeight,
      guides: [{ axis: 'x', position: x }, { axis: 'y', position: y }] });
    expect(positions(doc)).toEqual([[100, 150], [300, 310]]);
  });

  it('chooses nearest candidates, then canvas and document order for equal distances', () => {
    const doc = scene([['a', 100, 100, 80, 60], ['first', 300, 310, 120, 100], ['second', 308, 410, 121, 110]]);
    expect(snapResize(doc, 'a', 206, 77).width).toBe(208);
    expect(snapResize(doc, 'a', 204, 77).width).toBe(200);
    const canvasTie = scene([['a', 100, 100, 80, 60], ['other', 968, 300, 32, 100]]);
    expect(snapResize(canvasTie, 'a', 872, 77)).toEqual({ width: 876, height: 77, guides: [{ axis: 'x', position: 976 }] });
  });

  it('leaves stationary axes alone, including no-op clicks and returning to original dimensions', () => {
    const doc = scene([['a', 100, 150, 116, 104], ['other', 300, 310, 120, 100]]);
    expect(snapResize(doc, 'a', 116, 104)).toEqual({ width: 116, height: 104, guides: [] });
    expect(snapResize(doc, 'a', 116, 257)).toEqual({ width: 116, height: 260, guides: [{ axis: 'y', position: 410 }] });
    expect(snapResize(doc, 'a', 196, 104)).toEqual({ width: 200, height: 104, guides: [{ axis: 'x', position: 300 }] });
    snapResize(doc, 'a', 196, 257);
    expect(snapResize(doc, 'a', 116, 104)).toEqual({ width: 116, height: 104, guides: [] });
    const atEdge = scene([['a', 850, 450, 150, 150]]);
    expect(snapResize(atEdge, 'a', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toEqual({ width: 150, height: 150, guides: [] });
  });

  it('ignores self, distant candidates and invalid candidates rather than clamping them', () => {
    const self = scene([['a', 100, 150, 120, 100]]);
    expect(snapResize(self, 'a', 124, 104)).toEqual({ width: 124, height: 104, guides: [] });
    const doc = scene([['a', 900, 500, 80, 60], ['other', 999, 599, 1, 1]]);
    expect(snapResize(doc, 'a', 7, 8, 6, Number.MAX_SAFE_INTEGER)).toEqual({ width: 1, height: 8, guides: [{ axis: 'x', position: 901 }] });
    expect(snapResize(doc, 'a', 50, 40)).toEqual({ width: 50, height: 40, guides: [] });
    expect(snapResize(self, 'a', 22, 77, 1)).toEqual({ width: 22, height: 77, guides: [] });
    expect(snapResize(self, 'a', 876, 426, 0)).toEqual({ width: 876, height: 426,
      guides: [{ axis: 'x', position: 976 }, { axis: 'y', position: 576 }] });
  });

  it('clamps extreme dimensions, rejects invalid inputs and preserves frozen snapshots', () => {
    const doc = scene([['a', 900, 500, 80, 60], ['other', 100, 100, 300, 200]]);
    const before = serializeLayout(doc);
    freezeDeep(doc);
    expect(snapResize(doc, 'a', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toEqual({ width: 100, height: 100,
      guides: [{ axis: 'x', position: 1000 }, { axis: 'y', position: 600 }] });
    for (const width of [1, 7, 75, 81, 99, Number.MAX_SAFE_INTEGER]) {
      for (const height of [1, 7, 55, 61, 99, Number.MAX_SAFE_INTEGER]) {
        const snapped = snapResize(doc, 'a', width, height);
        expect(Number.isSafeInteger(snapped.width) && snapped.width >= 1 && snapped.width <= 100).toBe(true);
        expect(Number.isSafeInteger(snapped.height) && snapped.height >= 1 && snapped.height <= 100).toBe(true);
        for (const guide of snapped.guides) expect(guide.position).toBe(guide.axis === 'x' ? 900 + snapped.width : 500 + snapped.height);
      }
    }
    for (const value of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => snapResize(doc, 'a', value, 60)).toThrow('width');
      expect(() => snapResize(doc, 'a', 80, value)).toThrow('height');
    }
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => snapResize(doc, 'a', 80, 60, value)).toThrow('threshold');
      expect(() => snapResize(doc, 'a', 80, 60, 6, value)).toThrow('gutter');
    }
    expect(() => snapResize(doc, 'missing', 80, 60)).toThrow('was not found');
    expect(serializeLayout(doc)).toBe(before);
  });
});

describe('canvas warnings and snapshot safety', () => {
  it('reports only positive-area overlaps once, in paint order, and ignores touching edges/corners', () => {
    const doc = scene([['a', 0, 0, 120, 60], ['b', 119, 59, 120, 60], ['c', 120, 0, 120, 60], ['d', 240, 60, 120, 60]]);
    const warnings = canvasWarnings(doc);
    expect(warnings.map(({ kind, ids }) => ({ kind, ids }))).toEqual([
      { kind: 'overlap', ids: ['a', 'b'] }, { kind: 'overlap', ids: ['b', 'c'] },
    ]);
    expect(warnings.every(({ message }) => message.length > 0)).toBe(true);
    expect(validateLayout(doc)).toEqual(doc);
  });

  it('uses strict size thresholds and accepts an 80px compact clock', () => {
    const doc = scene([['narrow', 0, 0, 119, 80], ['short', 200, 0, 120, 59], ['minimum', 400, 0, 120, 60]]);
    doc.widgets.push({ id: 'clock', type: 'clock', x: 600, y: 0, width: 270, height: 80,
      settings: { label: 'Clock', time: '14:32', date: 'Tuesday', format: '24h', showDate: true } });
    freezeDeep(doc);
    expect(canvasWarnings(doc).map(({ kind, ids }) => ({ kind, ids }))).toEqual([
      { kind: 'small', ids: ['narrow'] }, { kind: 'small', ids: ['short'] },
    ]);
    expect(validateLayout(doc)).toEqual(doc);
  });

  it('caps warnings at 100 for both large overlap sets and small-widget sets', () => {
    const overlapping = scene(Array.from({ length: 70 }, (_, i) => [`w${i}`, 0, 0, 120, 60] as const));
    const warnings = canvasWarnings(overlapping);
    expect(warnings).toHaveLength(100);
    expect(warnings[0].ids).toEqual(['w0', 'w1']);
    expect(warnings[68].ids).toEqual(['w0', 'w69']);
    expect(warnings[69].ids).toEqual(['w1', 'w2']);
    expect(new Set(warnings.map(({ ids }) => ids.join(':'))).size).toBe(100);
    const small = scene(Array.from({ length: 125 }, (_, i) => [`s${i}`, 0, 0, 1, 1] as const));
    expect(canvasWarnings(small)).toHaveLength(100);
    expect(canvasWarnings(small).every(({ kind }) => kind === 'small')).toBe(true);
    expect(canvasWarnings(scene([]))).toEqual([]);
  });

  it('detaches changed documents all the way through nested designs and unselected settings', () => {
    const doc = scene([['a', 100, 100, 120, 60], ['b', 400, 300, 120, 60]]);
    doc.widgets.push({ id: 'clock', type: 'clock', x: 600, y: 0, width: 270, height: 80,
      settings: { label: 'Clock', time: '14:32', date: 'Tuesday', format: '24h', showDate: true },
      design: { elements: { time: { dx: 1, color: 'text' } } } });
    const before = serializeLayout(doc);
    freezeDeep(doc);
    const edits = [
      moveSelection(doc, ['a'], 1, 0), alignSelection(doc, ['a', 'b'], 'left'),
      distributeSelection(doc, ['a', 'b'], 'horizontal', 24), reorderSelection(doc, ['a'], 'front'),
      matchSelectionSize(doc, ['a', 'clock'], 'clock', 'height'),
    ];
    for (const edit of edits) {
      expect(edit.canvas).not.toBe(doc.canvas);
      expect(edit.palette).not.toBe(doc.palette);
      edit.palette.text = '#ffffff';
      const unselected = edit.widgets.find(({ id }) => id === 'b')!;
      if (unselected.type === 'text') unselected.settings.label = 'Changed';
      edit.widgets.find(({ id }) => id === 'clock')!.design!.elements!.time!.dx = 42;
      expect(serializeLayout(doc)).toBe(before);
    }
  });

  it('validates documents even for no-ops and rejects unsupported operation names', () => {
    const doc = scene([]);
    const bad = { ...doc, version: 2 } as unknown as LayoutDocument;
    for (const operation of [
      () => selectionIds(bad, []), () => selectionBounds(bad, []), () => moveSelection(bad, [], 0, 0),
      () => alignSelection(bad, [], 'left'), () => distributeSelection(bad, [], 'horizontal'),
      () => reorderSelection(bad, [], 'front'), () => snapSelection(bad, [], 0, 0), () => canvasWarnings(bad),
      () => matchSelectionSize(bad, [], 'missing', 'both'), () => snapResize(bad, 'missing', 1, 1),
    ]) expect(operation).toThrow('$.version');
    expect(() => alignSelection(doc, [], 'diagonal' as 'left')).toThrow('mode');
    expect(() => distributeSelection(doc, [], 'diagonal' as 'horizontal')).toThrow('axis');
    expect(() => reorderSelection(doc, [], 'up' as 'front')).toThrow('direction');
    expect(() => matchSelectionSize(doc, [], 'missing', 'area' as 'both')).toThrow('mode');
  });
});
