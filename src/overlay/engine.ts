import type { Shape } from '../shared/schema';

export type Tool = 'pen' | 'arrow' | 'box' | 'circle' | 'text' | 'pin' | 'eraser';
export type Pt = [number, number];

export const TOOLS: Tool[] = ['pen', 'arrow', 'box', 'circle', 'text', 'pin', 'eraser'];
export const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ffffff', '#111111'];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number) => Math.round(n * 10000) / 10000;

function distToSegment(p: Pt, a: Pt, b: Pt, aspect: number): number {
  // work in aspect-corrected space so that distances are isotropic
  const px = p[0] * aspect, py = p[1], ax = a[0] * aspect, ay = a[1], bx = b[0] * aspect, by = b[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function hitTest(shape: Shape, p: Pt, aspect: number, tol = 0.025): boolean {
  switch (shape.t) {
    case 'pen': {
      if (shape.pts.length === 1) return Math.hypot((p[0] - shape.pts[0][0]) * aspect, p[1] - shape.pts[0][1]) < tol;
      for (let i = 1; i < shape.pts.length; i++) if (distToSegment(p, shape.pts[i - 1], shape.pts[i], aspect) < tol) return true;
      return false;
    }
    case 'arrow':
      return distToSegment(p, shape.from, shape.to, aspect) < tol;
    case 'box': {
      const { x, y, w, h } = shape;
      const inside = p[0] >= x - tol / aspect && p[0] <= x + w + tol / aspect && p[1] >= y - tol && p[1] <= y + h + tol;
      return inside;
    }
    case 'circle': {
      const cx = shape.x + shape.w / 2, cy = shape.y + shape.h / 2;
      const rx = Math.max(shape.w / 2, 1e-6), ry = Math.max(shape.h / 2, 1e-6);
      const d = ((p[0] - cx) / (rx + tol / aspect)) ** 2 + ((p[1] - cy) / (ry + tol)) ** 2;
      return d <= 1;
    }
    case 'text': {
      const w = (shape.text.length * shape.size * 0.55) / aspect;
      return p[0] >= shape.x - tol && p[0] <= shape.x + w + tol && p[1] >= shape.y - shape.size - tol && p[1] <= shape.y + tol;
    }
    case 'pin':
      return Math.hypot((p[0] - shape.x) * aspect, p[1] - shape.y) < tol + 0.02;
  }
}

/** DOM-free drawing state: current shapes, in-progress shape, undo/redo. Coordinates are normalised 0..1. */
export class DrawingEngine {
  shapes: Shape[] = [];
  tool: Tool = 'pen';
  color = COLORS[0];
  /** stroke width as a fraction of anchor height */
  strokeWidth = 0.006;
  aspect = 16 / 9;
  private undoStack: Shape[][] = [];
  private redoStack: Shape[][] = [];
  private draft: Shape | null = null;
  private erasing = false;
  private erasedAny = false;
  onChange: () => void = () => {};

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get inProgress() {
    return this.draft !== null;
  }
  /** shapes including the in-progress one, for rendering */
  get visible(): Shape[] {
    return this.draft ? [...this.shapes, this.draft] : this.shapes;
  }

  private commit(next: Shape[]) {
    this.undoStack.push(this.shapes);
    this.redoStack = [];
    this.shapes = next;
    this.onChange();
  }

  begin(p: Pt): void {
    const q: Pt = [round(clamp01(p[0])), round(clamp01(p[1]))];
    const base = { c: this.color, sw: this.strokeWidth };
    switch (this.tool) {
      case 'pen':
        this.draft = { t: 'pen', ...base, pts: [q] };
        break;
      case 'arrow':
        this.draft = { t: 'arrow', ...base, from: q, to: q };
        break;
      case 'box':
        this.draft = { t: 'box', ...base, x: q[0], y: q[1], w: 0, h: 0 };
        break;
      case 'circle':
        this.draft = { t: 'circle', ...base, x: q[0], y: q[1], w: 0, h: 0 };
        break;
      case 'pin': {
        const n = this.shapes.filter((s) => s.t === 'pin').length + 1;
        this.commit([...this.shapes, { t: 'pin', c: this.color, x: q[0], y: q[1], label: String(n) }]);
        return;
      }
      case 'eraser':
        this.erasing = true;
        this.erasedAny = false;
        this.eraseAt(q);
        return;
      case 'text':
        return; // handled by addText (UI asks for the string)
    }
    this.start = q;
    this.onChange();
  }
  private start: Pt = [0, 0];

  move(p: Pt): void {
    const q: Pt = [round(clamp01(p[0])), round(clamp01(p[1]))];
    if (this.erasing) return void this.eraseAt(q);
    const d = this.draft;
    if (!d) return;
    switch (d.t) {
      case 'pen': {
        const last = d.pts[d.pts.length - 1];
        if (Math.hypot((q[0] - last[0]) * this.aspect, q[1] - last[1]) > 0.002) d.pts.push(q);
        break;
      }
      case 'arrow':
        d.to = q;
        break;
      case 'box':
      case 'circle':
        d.x = Math.min(this.start[0], q[0]);
        d.y = Math.min(this.start[1], q[1]);
        d.w = Math.abs(q[0] - this.start[0]);
        d.h = Math.abs(q[1] - this.start[1]);
        break;
    }
    this.onChange();
  }

  end(): void {
    if (this.erasing) {
      this.erasing = false;
      return;
    }
    const d = this.draft;
    this.draft = null;
    if (!d) return;
    const tiny =
      (d.t === 'arrow' && Math.hypot((d.to[0] - d.from[0]) * this.aspect, d.to[1] - d.from[1]) < 0.01) ||
      ((d.t === 'box' || d.t === 'circle') && d.w * this.aspect < 0.01 && d.h < 0.01);
    if (tiny) return void this.onChange();
    this.commit([...this.shapes, d]);
  }

  addText(p: Pt, text: string, size = 0.045): void {
    const t = text.trim();
    if (!t) return;
    this.commit([...this.shapes, { t: 'text', c: this.color, size, x: round(clamp01(p[0])), y: round(clamp01(p[1])), text: t }]);
  }

  private eraseAt(p: Pt): void {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      if (hitTest(this.shapes[i], p, this.aspect)) {
        const next = this.shapes.filter((_, j) => j !== i);
        if (!this.erasedAny) {
          this.undoStack.push(this.shapes);
          this.redoStack = [];
          this.erasedAny = true;
        }
        this.shapes = next;
        this.onChange();
        return;
      }
    }
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.shapes);
    this.shapes = prev;
    this.draft = null;
    this.onChange();
  }
  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.shapes);
    this.shapes = next;
    this.onChange();
  }
  clear(): void {
    if (this.shapes.length) this.commit([]);
  }
  /** After a note was saved: start fresh, without undo history. */
  reset(): void {
    this.shapes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.draft = null;
    this.onChange();
  }
}

/** Renders normalised shapes into a canvas context of size w x h (device pixels). */
export function renderShapes(ctx: CanvasRenderingContext2D, shapes: Shape[], w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of shapes) {
    ctx.strokeStyle = s.c;
    ctx.fillStyle = s.c;
    const lw = 'sw' in s ? Math.max(2, s.sw * h) : 2;
    ctx.lineWidth = lw;
    switch (s.t) {
      case 'pen': {
        ctx.beginPath();
        s.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * w, y * h) : ctx.lineTo(x * w, y * h)));
        if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * w + 0.1, s.pts[0][1] * h);
        ctx.stroke();
        break;
      }
      case 'arrow': {
        const [x1, y1] = [s.from[0] * w, s.from[1] * h];
        const [x2, y2] = [s.to[0] * w, s.to[1] * h];
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(12, h * 0.04);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
        ctx.stroke();
        break;
      }
      case 'box':
        ctx.strokeRect(s.x * w, s.y * h, s.w * w, s.h * h);
        break;
      case 'circle':
        ctx.beginPath();
        ctx.ellipse((s.x + s.w / 2) * w, (s.y + s.h / 2) * h, Math.max(1, (s.w * w) / 2), Math.max(1, (s.h * h) / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'text': {
        const px = Math.max(10, s.size * h);
        ctx.font = `600 ${px}px system-ui, sans-serif`;
        ctx.textBaseline = 'alphabetic';
        ctx.lineWidth = Math.max(3, px * 0.14);
        ctx.strokeStyle = s.c === '#111111' ? '#ffffff' : '#000000';
        ctx.strokeText(s.text, s.x * w, s.y * h);
        ctx.fillStyle = s.c;
        ctx.fillText(s.text, s.x * w, s.y * h);
        break;
      }
      case 'pin': {
        const r = Math.max(9, h * 0.022);
        ctx.beginPath();
        ctx.arc(s.x * w, s.y * h, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        if (s.label) {
          ctx.fillStyle = s.c === '#ffffff' ? '#111111' : '#ffffff';
          ctx.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(s.label, s.x * w, s.y * h + 1);
          ctx.textAlign = 'start';
        }
        break;
      }
    }
  }
}
