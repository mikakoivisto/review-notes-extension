/**
 * Remotion Studio adapter.
 *
 * Remotion's Studio DOM is UNDOCUMENTED. Everything below was observed on Remotion Studio 4.0.543
 * (see docs/SPEC.md §5.3) and is an implementation detail that can change with any release. All Remotion
 * knowledge is isolated in this file (+ src/content/bridge-main.ts); a fixture test pins the observed DOM
 * and an e2e test runs against a real Studio so drift is caught.
 */
import { frameToSeconds, parseFps, remotionTimecodeToFrame } from '../shared/time';
import type { MediaDescriptor, TimeRef } from '../shared/schema';
import type { AdapterContext, AdapterSession, MediaState, Rect, SiteAdapter } from './types';

import { BRIDGE_SOURCE_BRIDGE, BRIDGE_SOURCE_CONTENT } from './bridge-protocol';
const LS_KEY = 'remotion.time-all';

export type FrameStrategy = 'dragger-aria' | 'dragger-text' | 'localStorage';

export interface RemotionSnapshot {
  compositionId: string;
  fps: number | undefined;
  frame: number | undefined;
  strategy: FrameStrategy | undefined;
  /** Frame persisted by Studio in localStorage: only updated on pause/seek (stale while playing). */
  persistedFrame: number | undefined;
  durationFrames: number | undefined;
  width: number | undefined;
  height: number | undefined;
}

export function isRemotionStudio(doc: Document): boolean {
  return /-\s*Remotion Studio\s*$/.test(doc.title) || !!doc.querySelector('.remotion-studio-composition-container');
}

export function compositionIdFromPath(pathname: string): string {
  return decodeURIComponent(pathname).replace(/^\/+/, '').replace(/\/+$/, '');
}

function draggers(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>('button.__remotion_input_dragger'));
}
const byLabel = (list: HTMLElement[], label: string) => list.find((b) => b.getAttribute('aria-label') === label);

function readPersisted(storage: Storage | undefined, comp: string): number | undefined {
  try {
    const raw = storage?.getItem(LS_KEY);
    if (!raw) return undefined;
    const v = (JSON.parse(raw) as Record<string, unknown>)[comp];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Pure(ish) read of everything we can learn from a Studio document. Exported for fixture tests. */
export function readRemotionSnapshot(doc: Document, pathname: string, storage?: Storage): RemotionSnapshot {
  const list = draggers(doc);
  const compositionId = compositionIdFromPath(pathname);
  const fps = parseFps(byLabel(list, 'Frame Rate')?.textContent);
  const persistedFrame = readPersisted(storage, compositionId);

  let frame: number | undefined;
  let strategy: FrameStrategy | undefined;
  // 1. live: the playhead time button's aria-label is the frame number (updates every tick, also while playing)
  const live = list.find((b) => /^\d+$/.test(b.getAttribute('aria-label') ?? ''));
  if (live) {
    frame = Number(live.getAttribute('aria-label'));
    strategy = 'dragger-aria';
  } else {
    // 2. its text is "MM:SS.FF" (FF = frames at fps)
    const timeBtn = list.find((b) => /^\d+:\d{2}\.\d{2}$/.test(b.textContent?.trim() ?? '') && !['Duration'].includes(b.getAttribute('aria-label') ?? ''));
    if (timeBtn && fps) {
      frame = remotionTimecodeToFrame(timeBtn.textContent ?? '', fps);
      strategy = 'dragger-text';
    }
  }
  // 3. paused-only fallback
  if (frame === undefined && persistedFrame !== undefined) {
    frame = persistedFrame;
    strategy = 'localStorage';
  }

  const durText = byLabel(list, 'Duration')?.textContent?.trim();
  const durationFrames = durText && fps ? remotionTimecodeToFrame(durText, fps) : undefined;
  const px = (label: string) => {
    const m = /(\d+)\s*px/.exec(byLabel(list, label)?.textContent ?? '');
    return m ? Number(m[1]) : undefined;
  };
  return { compositionId, fps, frame, strategy, persistedFrame, durationFrames, width: px('Width'), height: px('Height') };
}

function pictureRect(doc: Document): Rect | null {
  const el = doc.querySelector('.remotion-studio-composition-container');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}

let reqCounter = 0;

/** Polls `cond` every 50 ms until it holds or `ms` elapsed. */
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

class RemotionSession implements AdapterSession {
  capabilities = { seek: true, pause: true, frameAccurate: true };
  lastStrategy: FrameStrategy | undefined;

  constructor(private ctx: AdapterContext) {}

  private snap(): RemotionSnapshot {
    const s = readRemotionSnapshot(this.ctx.document, this.ctx.url.pathname, safeStorage(this.ctx.window));
    this.lastStrategy = s.strategy;
    return s;
  }

  getState(): MediaState | null {
    const s = this.snap();
    if (s.frame === undefined || !s.fps) return null;
    return {
      timeSeconds: frameToSeconds(s.frame, s.fps),
      frame: s.frame,
      fps: s.fps,
      durationSeconds: s.durationFrames !== undefined ? frameToSeconds(s.durationFrames, s.fps) : undefined,
      // Studio persists the frame only on pause/seek, so live === persisted means "not playing".
      paused: s.persistedFrame !== undefined ? s.persistedFrame === s.frame : true,
    };
  }

  getMediaRect(): Rect | null {
    return pictureRect(this.ctx.document);
  }

  describe(): MediaDescriptor | null {
    const s = this.snap();
    return {
      kind: 'composition',
      compositionId: s.compositionId || undefined,
      durationSeconds: s.durationFrames !== undefined && s.fps ? frameToSeconds(s.durationFrames, s.fps) : undefined,
      width: s.width,
      height: s.height,
    };
  }

  /**
   * Seek through the MAIN-world bridge (window.remotion_setFrame). A playing preview is paused first: seeking
   * while it plays gets overwritten by the next tick (verified by e2e: the read-back never matched).
   */
  async seek(t: TimeRef): Promise<boolean> {
    const s = this.snap();
    const fps = s.fps ?? t.fps;
    const frame = t.frame ?? (fps ? Math.round(t.seconds * fps) : undefined);
    if (frame === undefined) return false;
    if (this.getState()?.paused === false) {
      this.pause();
      await until(() => this.getState()?.paused !== false, 1500);
    }
    if (!(await callBridge(this.ctx.window, 'setFrame', { frame, composition: s.compositionId }))) return false;
    return until(() => this.snap().frame === frame, 1000);
  }

  pause(): void {
    const st = this.getState();
    if (st && !st.paused) {
      // Space toggles playback in the Studio.
      const opts = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true } as KeyboardEventInit;
      this.ctx.document.body.dispatchEvent(new KeyboardEvent('keydown', opts));
      this.ctx.document.body.dispatchEvent(new KeyboardEvent('keyup', opts));
    }
  }

  dispose(): void {}
}

function safeStorage(win: Window): Storage | undefined {
  try {
    return win.localStorage;
  } catch {
    return undefined;
  }
}

export function callBridge(win: Window, cmd: string, args: Record<string, unknown>, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `rn-${++reqCounter}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      win.removeEventListener('message', onMsg);
      resolve(false);
    }, timeoutMs);
    function onMsg(e: MessageEvent) {
      if (e.source !== win || e.data?.source !== BRIDGE_SOURCE_BRIDGE || e.data.id !== id) return;
      clearTimeout(timer);
      win.removeEventListener('message', onMsg);
      resolve(!!e.data.ok);
    }
    win.addEventListener('message', onMsg);
    win.postMessage({ source: BRIDGE_SOURCE_CONTENT, id, cmd, ...args }, '*');
  });
}

export const remotionAdapter: SiteAdapter = {
  id: 'remotion',
  displayName: 'Remotion Studio',
  priority: 100,
  matches: (ctx) => isRemotionStudio(ctx.document),
  attach: (ctx) => new RemotionSession(ctx),
};
