import { COLORS, DrawingEngine, TOOLS, renderShapes, type Tool } from './engine';
import { OVERLAY_CSS } from './styles';
import type { Annotation, NoteType } from '../shared/schema';
import { NOTE_TYPES } from '../shared/enums';
import type { Rect } from '../shared/messages';

export interface Anchor {
  kind: 'media' | 'viewport';
  rect: Rect;
}

export interface OverlayHooks {
  getAnchor(): Anchor;
  /** label shown in the toolbar, e.g. "00:12.40 · frame 372"; null when no time is available */
  getTimeLabel(): { label: string; warn?: string } | null;
  pauseMedia(): void;
  onSave(input: { text: string; type: NoteType }): Promise<{ warning?: string } | void>;
  onClose(): void;
}

const TOOL_LABEL: Record<Tool, string> = { pen: '✏️ Pen', arrow: '➚ Arrow', box: '▭ Box', circle: '◯ Circle', text: 'T Text', pin: '📍 Pin', eraser: '⌫ Erase' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export class Overlay {
  readonly engine = new DrawingEngine();
  private host!: HTMLElement;
  private shadow!: ShadowRoot;
  private draw!: HTMLCanvasElement;
  private ghost!: HTMLCanvasElement;
  private frame!: HTMLElement;
  private toolbar!: HTMLElement;
  private composer!: HTMLElement;
  private toastEl!: HTMLElement;
  private timeEl!: HTMLElement;
  private raf = 0;
  private lastKey = '';
  private lastTimeText = 0;
  private drawing = false;
  private ghostTimer: number | undefined;
  private drawOn = false;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private swatches: HTMLButtonElement[] = [];
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private drawToggle!: HTMLButtonElement;
  private anchor: Anchor = { kind: 'viewport', rect: { x: 0, y: 0, width: innerWidth, height: innerHeight } };
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private swallow = (e: KeyboardEvent) => {
    // keep page hotkeys (YouTube "k", Remotion Space, …) from firing while typing in our UI
    if (this.host.matches(':focus-within') || this.shadow.activeElement) {
      const t = this.shadow.activeElement;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT')) e.stopImmediatePropagation();
    }
  };

  constructor(private hooks: OverlayHooks) {}

  get mounted() {
    return !!this.host?.isConnected;
  }

  mount(): void {
    if (this.mounted) return;
    this.host = el('div', undefined, { id: 'review-notes-root', 'data-testid': 'rn-host' });
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet(); // constructable sheets are not subject to the page's CSP style-src
    sheet.replaceSync(OVERLAY_CSS);
    this.shadow.adoptedStyleSheets = [sheet];
    const root = el('div', 'root');
    this.frame = el('div', 'anchor-frame');
    this.ghost = el('canvas', 'ghost');
    this.draw = el('canvas', 'draw', { 'data-testid': 'draw-canvas' });
    this.toolbar = this.buildToolbar();
    this.composer = this.buildComposer();
    this.toastEl = el('div', 'toast', { 'data-testid': 'toast' });
    this.toastEl.hidden = true;
    this.composer.hidden = true;
    root.append(this.frame, this.ghost, this.draw, this.toolbar, this.composer, this.toastEl);
    this.shadow.append(root);
    (document.documentElement || document.body).appendChild(this.host);
    if (!this.host.isConnected || !this.host.shadowRoot) throw new Error('overlay could not be attached');

    this.engine.onChange = () => {
      this.redraw();
      this.syncButtons();
    };
    this.wireCanvas();
    window.addEventListener('keydown', this.swallow, true);
    window.addEventListener('keyup', this.swallow, true);
    window.addEventListener('keypress', this.swallow, true);
    window.addEventListener('keydown', this.keyHandler, true);
    this.tick();
    this.syncButtons();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.swallow, true);
    window.removeEventListener('keyup', this.swallow, true);
    window.removeEventListener('keypress', this.swallow, true);
    window.removeEventListener('keydown', this.keyHandler, true);
    this.host?.remove();
  }

  // ---- public API -------------------------------------------------------------------------------------------
  getAnnotation(): Annotation | null {
    if (!this.engine.shapes.length) return null;
    return { anchor: this.anchor.kind, aspect: this.anchor.rect.width / Math.max(1, this.anchor.rect.height), shapes: structuredClone(this.engine.shapes) };
  }
  getAnchor(): Anchor {
    return this.anchor;
  }
  /** Hides toolbar/composer/toast (and optionally the drawing) so a screenshot is clean. */
  setCapturing(on: boolean, opts: { hideDrawing?: boolean } = {}): void {
    if (on) this.host.setAttribute('data-capturing', '');
    else this.host.removeAttribute('data-capturing');
    this.draw.hidden = on && !!opts.hideDrawing;
    this.ghost.hidden = on && !!opts.hideDrawing;
  }
  showGhost(a: Annotation | null, ms = 12000): void {
    this.hideGhost();
    if (!a || !a.shapes.length) return;
    this.updateLayout(true);
    const g = this.ghost.getContext('2d')!;
    renderShapes(g, a.shapes, this.ghost.width, this.ghost.height);
    this.ghost.hidden = false;
    this.ghostTimer = window.setTimeout(() => this.hideGhost(), ms);
  }
  hideGhost(): void {
    clearTimeout(this.ghostTimer);
    this.ghost.getContext('2d')?.clearRect(0, 0, this.ghost.width, this.ghost.height);
  }
  toast(msg: string, warn = false, ms = 3500): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.toggle('warn', warn);
    this.toastEl.hidden = false;
    setTimeout(() => (this.toastEl.hidden = true), ms);
  }
  resetDrawing(): void {
    this.engine.reset();
  }

  // ---- UI construction --------------------------------------------------------------------------------------
  private btn(label: string, testid: string, onClick: () => void, title?: string): HTMLButtonElement {
    const b = el('button', undefined, { 'data-testid': testid, type: 'button' });
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  private buildToolbar(): HTMLElement {
    const bar = el('div', 'toolbar', { 'data-testid': 'toolbar' });
    const grip = el('span', 'grip');
    grip.textContent = '⠿';
    grip.title = 'Drag';
    this.makeDraggable(bar, grip);
    bar.append(grip);

    for (const t of TOOLS) {
      const b = this.btn(TOOL_LABEL[t], `tool-${t}`, () => this.selectTool(t), t);
      this.toolButtons.set(t, b);
      bar.append(b);
    }
    bar.append(el('span', 'sep'));
    COLORS.forEach((c) => {
      const s = el('button', 'swatch', { 'data-testid': `color-${c.slice(1)}`, title: c, type: 'button' });
      s.style.background = c;
      s.addEventListener('click', () => {
        this.engine.color = c;
        this.syncButtons();
      });
      this.swatches.push(s);
      bar.append(s);
    });
    bar.append(el('span', 'sep'));
    this.undoBtn = this.btn('↶', 'btn-undo', () => this.engine.undo(), 'Undo (Ctrl+Z)');
    this.redoBtn = this.btn('↷', 'btn-redo', () => this.engine.redo(), 'Redo (Ctrl+Shift+Z)');
    bar.append(this.undoBtn, this.redoBtn, this.btn('Clear', 'btn-clear', () => this.engine.clear(), 'Clear drawing'));
    bar.append(el('span', 'sep'));
    this.drawToggle = this.btn('✋ Interact', 'btn-interact', () => this.setDrawMode(!this.drawOn), 'Toggle draw / interact with the page (Esc)');
    bar.append(this.drawToggle);
    this.timeEl = el('span', 'time', { 'data-testid': 'timecode' });
    bar.append(this.timeEl);
    const add = this.btn('＋ Add note', 'btn-add-note', () => this.openComposer());
    add.classList.add('primary');
    bar.append(add, this.btn('✕', 'btn-close', () => this.hooks.onClose(), 'Close review (stop)'));
    return bar;
  }

  private makeDraggable(bar: HTMLElement, grip: HTMLElement) {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = bar.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      bar.style.transform = 'none';
      const move = (ev: PointerEvent) => {
        bar.style.left = `${Math.max(0, Math.min(innerWidth - 40, ev.clientX - dx))}px`;
        bar.style.top = `${Math.max(0, Math.min(innerHeight - 30, ev.clientY - dy))}px`;
      };
      const up = () => {
        removeEventListener('pointermove', move, true);
        removeEventListener('pointerup', up, true);
      };
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', up, true);
    });
  }

  private composerRefs!: { text: HTMLTextAreaElement; type: HTMLSelectElement; meta: HTMLElement; warn: HTMLElement; save: HTMLButtonElement };

  private buildComposer(): HTMLElement {
    const c = el('div', 'composer', { 'data-testid': 'composer' });
    const text = el('textarea', undefined, { 'data-testid': 'note-text', placeholder: 'What should change here?' });
    const type = el('select', undefined, { 'data-testid': 'note-type' });
    for (const t of NOTE_TYPES) {
      const o = el('option');
      o.value = t;
      o.textContent = t;
      type.append(o);
    }
    const meta = el('span', 'meta', { 'data-testid': 'composer-meta' });
    const warn = el('div', 'warn', { 'data-testid': 'composer-warn' });
    const cancel = el('button', undefined, { 'data-testid': 'note-cancel', type: 'button' });
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => (this.composer.hidden = true));
    const save = el('button', 'save', { 'data-testid': 'note-save', type: 'button' });
    save.textContent = 'Save note';
    save.addEventListener('click', () => void this.submit());
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void this.submit();
      if (e.key === 'Escape') this.composer.hidden = true;
    });
    const row1 = el('div', 'row');
    row1.append(meta, type);
    const row2 = el('div', 'row');
    row2.append(cancel, save);
    c.append(row1, text, warn, row2);
    this.composerRefs = { text, type, meta, warn, save };
    return c;
  }

  private openComposer() {
    this.hooks.pauseMedia();
    const r = this.composerRefs;
    const tl = this.hooks.getTimeLabel();
    r.meta.textContent = tl ? tl.label : 'Page note (no timecode)';
    r.warn.textContent = tl?.warn ?? '';
    r.type.value = this.engine.shapes.length ? 'visual' : 'general';
    this.composer.hidden = false;
    r.text.focus();
  }

  private async submit() {
    const r = this.composerRefs;
    if (r.save.disabled) return;
    r.save.disabled = true;
    const text = r.text.value.trim();
    try {
      const res = await this.hooks.onSave({ text, type: r.type.value as NoteType });
      this.composer.hidden = true;
      r.text.value = '';
      this.toast(res && res.warning ? `Note saved. ${res.warning}` : 'Note saved', !!(res && res.warning), res && res.warning ? 6000 : 2500);
    } catch (e) {
      r.warn.textContent = `Could not save: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      r.save.disabled = false;
    }
  }

  // ---- drawing ----------------------------------------------------------------------------------------------
  private selectTool(t: Tool) {
    this.engine.tool = t;
    this.setDrawMode(true);
    this.syncButtons();
  }

  setDrawMode(on: boolean) {
    this.drawOn = on;
    if (on) this.hooks.pauseMedia();
    this.draw.classList.toggle('on', on);
    this.draw.classList.toggle('eraser', on && this.engine.tool === 'eraser');
    this.draw.classList.toggle('text', on && this.engine.tool === 'text');
    this.syncButtons();
  }

  private norm(e: PointerEvent): [number, number] {
    const r = this.draw.getBoundingClientRect();
    return [(e.clientX - r.left) / Math.max(1, r.width), (e.clientY - r.top) / Math.max(1, r.height)];
  }

  private wireCanvas() {
    const c = this.draw;
    c.addEventListener('pointerdown', (e) => {
      if (!this.drawOn || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.engine.aspect = this.anchor.rect.width / Math.max(1, this.anchor.rect.height);
      this.hideGhost();
      const p = this.norm(e);
      if (this.engine.tool === 'text') return void this.askText(e, p);
      c.setPointerCapture(e.pointerId);
      this.drawing = true;
      this.engine.begin(p);
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drawing) this.engine.move(this.norm(e));
    });
    const up = (e: PointerEvent) => {
      if (!this.drawing) return;
      this.drawing = false;
      this.engine.move(this.norm(e));
      this.engine.end();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  private askText(e: PointerEvent, p: [number, number]) {
    const input = el('input', 'text-input', { 'data-testid': 'text-input', placeholder: 'Type, Enter to place' });
    input.style.left = `${e.clientX}px`;
    input.style.top = `${e.clientY}px`;
    const finish = (commit: boolean) => {
      if (commit) this.engine.addText(p, input.value);
      input.remove();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => input.isConnected && finish(true));
    this.shadow.append(input);
    setTimeout(() => input.focus(), 0);
  }

  private onKey(e: KeyboardEvent) {
    if (!this.mounted) return;
    const typing = this.shadow.activeElement && ['TEXTAREA', 'INPUT', 'SELECT'].includes(this.shadow.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing && this.drawOn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.shiftKey ? this.engine.redo() : this.engine.undo();
    } else if (e.key === 'Escape' && !typing && this.drawOn) {
      this.setDrawMode(false);
    }
  }

  // ---- layout / rendering -----------------------------------------------------------------------------------
  private syncButtons() {
    for (const [t, b] of this.toolButtons) b.classList.toggle('active', this.drawOn && this.engine.tool === t);
    this.swatches.forEach((s) => s.classList.toggle('active', s.title === this.engine.color));
    this.undoBtn.disabled = !this.engine.canUndo;
    this.redoBtn.disabled = !this.engine.canRedo;
    this.drawToggle.classList.toggle('active', !this.drawOn);
    this.draw.classList.toggle('eraser', this.drawOn && this.engine.tool === 'eraser');
    this.draw.classList.toggle('text', this.drawOn && this.engine.tool === 'text');
  }

  private updateLayout(force = false) {
    const a = this.hooks.getAnchor();
    const r = a.rect;
    const key = `${a.kind}|${Math.round(r.x)}|${Math.round(r.y)}|${Math.round(r.width)}|${Math.round(r.height)}|${devicePixelRatio}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.anchor = a;
    this.engine.aspect = r.width / Math.max(1, r.height);
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const c of [this.draw, this.ghost]) {
      c.style.left = `${r.x}px`;
      c.style.top = `${r.y}px`;
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    this.frame.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;`;
    this.frame.hidden = a.kind !== 'media';
    this.redraw();
  }

  private redraw() {
    const g = this.draw.getContext('2d');
    if (g) renderShapes(g, this.engine.visible, this.draw.width, this.draw.height);
  }

  private tick = () => {
    if (!this.mounted) return;
    this.updateLayout();
    const now = performance.now();
    if (now - this.lastTimeText > 150) {
      this.lastTimeText = now;
      const t = this.hooks.getTimeLabel();
      this.timeEl.textContent = t ? t.label : 'page';
      this.timeEl.classList.toggle('warn', !!t?.warn);
      this.timeEl.title = t?.warn ?? '';
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}
