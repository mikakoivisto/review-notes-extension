import { resolveAdapter, toTimeRef, type AdapterSession, type SiteAdapter } from '../adapters';
import { Overlay, type Anchor } from '../overlay/overlay';
import { formatTime } from '../shared/time';
import { callSw } from '../shared/rpc';
import type { CaptureResult, ContentMessage, TabState } from '../shared/messages';
import type { Note } from '../shared/schema';

interface Instance {
  alive(): boolean;
  destroy(): void;
}
declare global {
  interface Window {
    __reviewNotes?: Instance;
  }
}

const raf2 = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function init(): Instance {
  let adapter: SiteAdapter;
  let session: AdapterSession;
  let overlay: Overlay | null = null;
  let overlayFailed: string | undefined;
  let lastHref = '';
  let timer: number | undefined;

  const ctx = () => ({ url: new URL(location.href), document, window });

  function refreshAdapter(force = false) {
    const href = location.href;
    if (!force && adapter && href === lastHref && adapter.id !== 'generic') return;
    lastHref = href;
    const prev = adapter?.id;
    session?.dispose();
    ({ adapter, session } = resolveAdapter(ctx(), undefined, (m, e) => console.warn('[review-notes]', m, e)));
    if (adapter.id === 'remotion' && prev !== 'remotion') void callSw({ type: 'bridge:ensure' }).catch(() => {});
  }
  refreshAdapter(true);
  // media can appear later (SPA navigation, lazy players): re-resolve while we only have the generic adapter
  timer = window.setInterval(() => refreshAdapter(), 1000);

  function anchor(): Anchor {
    const r = session.getMediaRect();
    if (r && r.width >= 40 && r.height >= 40) return { kind: 'media', rect: r };
    return { kind: 'viewport', rect: { x: 0, y: 0, width: innerWidth, height: innerHeight } };
  }

  async function capture(a: Anchor): Promise<CaptureResult> {
    return callSw<CaptureResult>({ type: 'capture:screenshot', req: { rect: a.kind === 'media' ? a.rect : null, innerWidth } });
  }

  async function save(input: { text: string; type: Note['type'] }) {
    if (!overlay) throw new Error('Review is not active');
    const annotation = overlay.getAnnotation();
    if (!input.text && !annotation) throw new Error('Write a note or draw something first');
    session.pause();
    const a = anchor();
    const state = session.getState();
    const media = session.describe();
    const screenshots: { annotated?: CaptureResult; clean?: CaptureResult } = {};
    let warning: string | undefined;
    try {
      overlay.setCapturing(true);
      await raf2();
      screenshots.annotated = await capture(a);
      if (annotation) {
        overlay.setCapturing(true, { hideDrawing: true });
        await raf2();
        screenshots.clean = await capture(a);
      }
    } catch (e) {
      warning = `Screenshot failed (${e instanceof Error ? e.message : e}).`;
    } finally {
      overlay.setCapturing(false);
    }
    await callSw({
      type: 'note:create',
      payload: {
        note: {
          url: location.href,
          pageTitle: document.title,
          adapter: adapter.id,
          media,
          time: state ? toTimeRef(state) : null,
          type: input.type,
          text: input.text,
          annotation: annotation ? { ...annotation, anchor: a.kind } : null,
          context: { scrollX: scrollX, scrollY: scrollY, viewportWidth: innerWidth, viewportHeight: innerHeight, devicePixelRatio, userAgent: navigator.userAgent },
        },
        screenshots,
      },
    });
    overlay.resetDrawing();
    // judge blackness on the CLEAN capture: our own drawing on top would make a black frame look "not black"
    if (!warning && (screenshots.clean ?? screenshots.annotated)?.suspectedBlack) warning = 'The screenshot looks black (DRM-protected video?). Timecode and drawing were kept.';
    return warning ? { warning } : undefined;
  }

  function start() {
    refreshAdapter(true);
    overlayFailed = undefined;
    if (!overlay) {
      overlay = new Overlay({
        getAnchor: anchor,
        getTimeLabel: () => {
          const s = session.getState();
          if (!s) return null;
          const label = formatTime(toTimeRef(s)) + (s.paused ? '' : ' ▶');
          return { label, warn: s.adPlaying ? 'An ad is playing: this timestamp belongs to the ad, not the video' : undefined };
        },
        pauseMedia: () => session.pause(),
        onSave: save,
        onClose: stop,
      });
    }
    try {
      overlay.mount();
    } catch (e) {
      overlayFailed = e instanceof Error ? e.message : String(e);
      overlay = null;
    }
  }

  function stop() {
    overlay?.destroy();
    overlay = null;
  }

  function state(): TabState {
    const s = session.getState();
    return {
      active: !!overlay?.mounted,
      adapter: adapter.id,
      adapterName: adapter.displayName,
      title: document.title,
      url: location.href,
      time: s ? toTimeRef(s) : null,
      paused: s ? s.paused : null,
      canSeek: session.capabilities.seek,
      media: session.describe(),
      overlayFailed,
    };
  }

  async function gotoNote(note: Pick<Note, 'time' | 'annotation' | 'context' | 'adapter'>) {
    if (!overlay?.mounted) start();
    refreshAdapter(true);
    let seeked = false;
    if (note.time && session.capabilities.seek) {
      for (let i = 0; i < 6 && !seeked; i++) {
        seeked = await session.seek(note.time);
        if (!seeked) await sleep(400);
      }
    } else if (!note.time) {
      window.scrollTo(note.context.scrollX, note.context.scrollY);
      await sleep(50);
    }
    await raf2();
    overlay?.showGhost(note.annotation);
    return { seeked, hasTime: !!note.time };
  }

  const onMessage = (msg: ContentMessage, _s: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
    const reply = (p: Promise<unknown> | unknown) =>
      Promise.resolve(p).then(
        (data) => sendResponse({ ok: true, data }),
        (e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    switch (msg.type) {
      case 'tab:ping':
        reply({ pong: true });
        break;
      case 'review:start':
        start();
        reply(state());
        break;
      case 'review:stop':
        stop();
        reply(state());
        break;
      case 'review:toggle':
        overlay?.mounted ? stop() : start();
        reply(state());
        break;
      case 'tab:getState':
        reply(state());
        break;
      case 'tab:goto':
        reply(gotoNote(msg.note));
        break;
      default:
        return false;
    }
    return true;
  };
  chrome.runtime.onMessage.addListener(onMessage);

  return {
    alive: () => !!chrome.runtime?.id,
    destroy() {
      clearInterval(timer);
      stop();
      session?.dispose();
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* context invalidated */
      }
    },
  };
}

(() => {
  const old = window.__reviewNotes;
  if (old) {
    let alive = false;
    try {
      alive = old.alive();
    } catch {
      alive = false;
    }
    if (alive) return; // idempotent re-injection
    try {
      old.destroy(); // orphaned by an extension reload
    } catch {
      /* ignore */
    }
  }
  window.__reviewNotes = init();
})();
