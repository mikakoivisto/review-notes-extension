import { describe, expect, it } from 'vitest';
import { DrawingEngine, hitTest } from '../../src/overlay/engine';
import type { Shape } from '../../src/shared/schema';
import { isSuspectedBlack } from '../../src/shared/blackframe';

function stroke(e: DrawingEngine, pts: [number, number][]) {
  e.begin(pts[0]);
  for (const p of pts.slice(1)) e.move(p);
  e.end();
}

describe('DrawingEngine', () => {
  it('draws pen/box/circle/arrow with normalised coordinates', () => {
    const e = new DrawingEngine();
    e.tool = 'pen';
    stroke(e, [[0.1, 0.1], [0.2, 0.3], [0.4, 0.4]]);
    e.tool = 'box';
    stroke(e, [[0.5, 0.6], [0.2, 0.2]]); // dragged up-left: normalised to top-left origin
    e.tool = 'circle';
    stroke(e, [[0.1, 0.1], [0.3, 0.2]]);
    e.tool = 'arrow';
    stroke(e, [[0.1, 0.9], [0.5, 0.5]]);
    expect(e.shapes.map((s) => s.t)).toEqual(['pen', 'box', 'circle', 'arrow']);
    const box = e.shapes[1] as { x: number; y: number; w: number; h: number };
    expect(box).toMatchObject({ x: 0.2, y: 0.2 });
    expect(box.w).toBeCloseTo(0.3);
    expect(box.h).toBeCloseTo(0.4);
  });
  it('clamps coordinates to 0..1', () => {
    const e = new DrawingEngine();
    e.tool = 'arrow';
    stroke(e, [[-0.5, 2], [1.5, -1]]);
    expect(e.shapes[0]).toMatchObject({ from: [0, 1], to: [1, 0] });
  });
  it('ignores accidental clicks (zero-size shapes)', () => {
    const e = new DrawingEngine();
    e.tool = 'box';
    stroke(e, [[0.5, 0.5], [0.5, 0.5]]);
    e.tool = 'arrow';
    stroke(e, [[0.5, 0.5], [0.5, 0.5]]);
    expect(e.shapes).toHaveLength(0);
  });
  it('pin numbers itself, text trims and skips empty', () => {
    const e = new DrawingEngine();
    e.tool = 'pin';
    e.begin([0.1, 0.1]);
    e.begin([0.2, 0.2]);
    expect(e.shapes.map((s) => (s as { label?: string }).label)).toEqual(['1', '2']);
    e.addText([0.3, 0.3], '  hello ');
    e.addText([0.3, 0.3], '   ');
    expect(e.shapes).toHaveLength(3);
    expect(e.shapes[2]).toMatchObject({ t: 'text', text: 'hello' });
  });
  it('undo / redo / clear', () => {
    const e = new DrawingEngine();
    e.tool = 'box';
    stroke(e, [[0.1, 0.1], [0.4, 0.4]]);
    stroke(e, [[0.5, 0.5], [0.9, 0.9]]);
    expect(e.shapes).toHaveLength(2);
    e.undo();
    expect(e.shapes).toHaveLength(1);
    expect(e.canRedo).toBe(true);
    e.redo();
    expect(e.shapes).toHaveLength(2);
    e.undo();
    stroke(e, [[0.6, 0.1], [0.8, 0.3]]); // new stroke drops the redo stack
    expect(e.canRedo).toBe(false);
    e.clear();
    expect(e.shapes).toHaveLength(0);
    e.undo(); // clear is undoable
    expect(e.shapes).toHaveLength(2);
  });
  it('eraser removes the topmost shape under the pointer as ONE undo step', () => {
    const e = new DrawingEngine();
    e.tool = 'box';
    stroke(e, [[0.1, 0.1], [0.3, 0.3]]);
    e.tool = 'arrow';
    stroke(e, [[0.6, 0.6], [0.9, 0.9]]);
    e.tool = 'eraser';
    e.begin([0.75, 0.75]); // on the arrow
    e.move([0.2, 0.2]); // drag onto the box
    e.end();
    expect(e.shapes).toHaveLength(0);
    e.undo();
    expect(e.shapes).toHaveLength(2);
  });
  it('hit testing respects aspect', () => {
    const arrow: Shape = { t: 'arrow', c: '#fff', sw: 0.01, from: [0.2, 0.5], to: [0.8, 0.5] };
    expect(hitTest(arrow, [0.5, 0.505], 16 / 9)).toBe(true);
    expect(hitTest(arrow, [0.5, 0.7], 16 / 9)).toBe(false);
    const circle: Shape = { t: 'circle', c: '#fff', sw: 0.01, x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    expect(hitTest(circle, [0.5, 0.5], 1)).toBe(true);
    expect(hitTest(circle, [0.95, 0.95], 1)).toBe(false);
  });
  it('reset drops history', () => {
    const e = new DrawingEngine();
    e.tool = 'box';
    stroke(e, [[0.1, 0.1], [0.4, 0.4]]);
    e.reset();
    expect(e.shapes).toHaveLength(0);
    expect(e.canUndo).toBe(false);
  });
});

describe('black frame detection', () => {
  const px = (r: number, g: number, b: number, n = 64) => new Uint8ClampedArray(Array.from({ length: n }, () => [r, g, b, 255]).flat());
  it('flags solid black', () => expect(isSuspectedBlack(px(0, 0, 0))).toBe(true));
  it('flags near-black with tiny noise', () => expect(isSuspectedBlack(px(2, 2, 2))).toBe(true));
  it('does not flag a bright or a dark-but-structured frame', () => {
    expect(isSuspectedBlack(px(200, 200, 200))).toBe(false);
    const mixed = new Uint8ClampedArray([...px(0, 0, 0, 32), ...px(255, 255, 255, 32)]);
    expect(isSuspectedBlack(mixed)).toBe(false);
  });
  it('handles empty input', () => expect(isSuspectedBlack(new Uint8ClampedArray())).toBe(false));
});
