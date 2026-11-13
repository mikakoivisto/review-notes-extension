import type { AdapterContext, AdapterSession, MediaState, Rect, SiteAdapter } from './types';
import type { MediaDescriptor, TimeRef } from '../shared/schema';

/** All <video> elements, including those in open shadow roots. */
export function collectVideos(root: Document | ShadowRoot | Element): HTMLVideoElement[] {
  const out: HTMLVideoElement[] = [];
  const walk = (node: Document | ShadowRoot | Element) => {
    node.querySelectorAll('video').forEach((v) => out.push(v));
    node.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  };
  walk(root);
  return out;
}

function area(r: DOMRect | Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

/** Visible, largest video; videos that play or have progressed are preferred. */
export function findBestVideo(root: Document | ShadowRoot | Element): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestScore = 0;
  for (const v of collectVideos(root)) {
    const r = v.getBoundingClientRect();
    if (r.width < 80 || r.height < 45) continue;
    let score = area(r);
    if (!v.paused && !v.ended) score *= 4;
    else if (v.currentTime > 0) score *= 2;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/** Picture rectangle of a <video>, removing object-fit letterboxing. */
export function videoPictureRect(v: HTMLVideoElement): Rect {
  const r = v.getBoundingClientRect();
  const box = { x: r.x, y: r.y, width: r.width, height: r.height };
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!vw || !vh || !r.width || !r.height) return box;
  let fit = 'fill';
  try {
    fit = v.ownerDocument.defaultView?.getComputedStyle(v).objectFit || 'fill';
  } catch {
    /* ignore */
  }
  // <video> without object-fit letterboxes by default ("contain" is the UA default for replaced video)
  if (fit === 'fill' && !v.style.objectFit) fit = 'contain';
  if (fit !== 'contain' && fit !== 'scale-down') return box;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, width: w, height: h };
}

export class Html5VideoSession implements AdapterSession {
  readonly capabilities = { seek: true, pause: true, frameAccurate: false };
  constructor(protected root: Document, protected video: HTMLVideoElement) {}

  protected current(): HTMLVideoElement | null {
    if (!this.video.isConnected) {
      const next = findBestVideo(this.root);
      if (next) this.video = next;
      else return null;
    }
    return this.video;
  }

  getState(): MediaState | null {
    const v = this.current();
    if (!v) return null;
    return {
      timeSeconds: v.currentTime,
      durationSeconds: Number.isFinite(v.duration) ? v.duration : undefined,
      paused: v.paused,
    };
  }

  getMediaRect(): Rect | null {
    const v = this.current();
    return v ? videoPictureRect(v) : null;
  }

  describe(): MediaDescriptor | null {
    const v = this.current();
    if (!v) return null;
    return {
      kind: 'video',
      durationSeconds: Number.isFinite(v.duration) ? v.duration : undefined,
      width: v.videoWidth || undefined,
      height: v.videoHeight || undefined,
      src: v.currentSrc || undefined,
    };
  }

  async seek(t: TimeRef): Promise<boolean> {
    const v = this.current();
    if (!v) return false;
    v.pause();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 3000);
      function done() {
        clearTimeout(timer);
        v!.removeEventListener('seeked', done);
        resolve();
      }
      v.addEventListener('seeked', done);
      v.currentTime = t.seconds;
    });
    return Math.abs(v.currentTime - t.seconds) < 0.5;
  }

  pause(): void {
    this.current()?.pause();
  }

  dispose(): void {}
}

export const html5Adapter: SiteAdapter = {
  id: 'html5-video',
  displayName: 'HTML5 video',
  priority: 10,
  matches: (ctx: AdapterContext) => findBestVideo(ctx.document) !== null,
  attach(ctx: AdapterContext) {
    const v = findBestVideo(ctx.document);
    return v ? new Html5VideoSession(ctx.document, v) : null;
  },
};
