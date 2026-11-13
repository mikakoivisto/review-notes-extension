// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAdapters, resolveAdapter, type SiteAdapter } from '../../src/adapters';
import { collectVideos, findBestVideo, html5Adapter, videoPictureRect } from '../../src/adapters/html5';
import { compositionIdFromPath, isRemotionStudio, readRemotionSnapshot, remotionAdapter } from '../../src/adapters/remotion';
import { isYouTubeUrl, youtubeAdapter, youtubeVideoId } from '../../src/adapters/youtube';

const ctx = (url = 'http://localhost/') => ({ url: new URL(url), document, window });

function video(opts: { w?: number; h?: number; vw?: number; vh?: number; paused?: boolean; time?: number; connected?: boolean; parent?: Element } = {}) {
  const v = document.createElement('video');
  const w = opts.w ?? 640, h = opts.h ?? 360;
  v.getBoundingClientRect = () => ({ x: 10, y: 20, width: w, height: h, left: 10, top: 20, right: 10 + w, bottom: 20 + h, toJSON() {} }) as DOMRect;
  Object.defineProperty(v, 'videoWidth', { value: opts.vw ?? 0 });
  Object.defineProperty(v, 'videoHeight', { value: opts.vh ?? 0 });
  Object.defineProperty(v, 'paused', { value: opts.paused ?? true, configurable: true });
  v.pause = vi.fn();
  let t = opts.time ?? 0;
  Object.defineProperty(v, 'currentTime', { get: () => t, set: (x) => { t = x; queueMicrotask(() => v.dispatchEvent(new Event('seeked'))); }, configurable: true });
  Object.defineProperty(v, 'duration', { value: 8, configurable: true });
  if (opts.connected !== false) (opts.parent ?? document.body).append(v);
  return v;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Test';
});

describe('html5 adapter', () => {
  it('picks the largest visible video, preferring playing ones, ignoring tiny ones', () => {
    video({ w: 50, h: 30 });
    const big = video({ w: 800, h: 450 });
    const playing = video({ w: 500, h: 300, paused: false });
    expect(findBestVideo(document)).toBe(playing); // 500*300*4 > 800*450
    Object.defineProperty(playing, 'paused', { value: true });
    expect(findBestVideo(document)).toBe(big);
  });
  it('finds videos inside open shadow roots', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = video({ parent: document.body });
    root.append(inner);
    expect(collectVideos(document)).toContain(inner);
    expect(findBestVideo(document)).toBe(inner);
  });
  it('computes the letterboxed picture rect (contain)', () => {
    const v = video({ w: 800, h: 600, vw: 1600, vh: 900 });
    const r = videoPictureRect(v);
    expect(r.width).toBeCloseTo(800);
    expect(r.height).toBeCloseTo(450);
    expect(r.y).toBeCloseTo(20 + 75);
    expect(r.x).toBeCloseTo(10);
  });
  it('falls back to the element rect when intrinsic size is unknown', () => {
    expect(videoPictureRect(video({ w: 300, h: 200 }))).toMatchObject({ width: 300, height: 200 });
  });
  it('reads state, describes, seeks (and pauses) and verifies', async () => {
    const v = video({ time: 2.5, vw: 640, vh: 360 });
    const { adapter, session } = resolveAdapter(ctx());
    expect(adapter.id).toBe('html5-video');
    expect(session.getState()).toMatchObject({ timeSeconds: 2.5, durationSeconds: 8, paused: true });
    expect(session.describe()).toMatchObject({ kind: 'video', width: 640, height: 360, durationSeconds: 8 });
    expect(await session.seek({ seconds: 6 })).toBe(true);
    expect(v.currentTime).toBe(6);
    expect(v.pause).toHaveBeenCalled();
  });
  it('re-finds a video when the original is detached, returns null state when none', () => {
    const a = video();
    const session = html5Adapter.attach(ctx())!;
    a.remove();
    expect(session.getState()).toBeNull();
    const b = video({ time: 1 });
    expect(session.getState()?.timeSeconds).toBe(1);
    expect(b.isConnected).toBe(true);
  });
  it('does not match pages without a usable video', () => {
    expect(html5Adapter.matches(ctx())).toBe(false);
    video({ w: 20, h: 10 });
    expect(html5Adapter.matches(ctx())).toBe(false);
  });
});

describe('youtube adapter', () => {
  it('recognises URLs and extracts ids', () => {
    expect(isYouTubeUrl(new URL('https://www.youtube.com/watch?v=abc123XYZ_-'))).toBe(true);
    expect(isYouTubeUrl(new URL('https://m.youtube.com/shorts/abcdef12345'))).toBe(true);
    expect(isYouTubeUrl(new URL('https://youtu.be/abcdef12345'))).toBe(true);
    expect(isYouTubeUrl(new URL('https://www.youtube.com/feed/subscriptions'))).toBe(false);
    expect(isYouTubeUrl(new URL('https://example.com/watch?v=1'))).toBe(false);
    expect(youtubeVideoId(new URL('https://www.youtube.com/watch?v=abc123XYZ_-&t=3'))).toBe('abc123XYZ_-');
    expect(youtubeVideoId(new URL('https://www.youtube.com/shorts/abcdef12345'))).toBe('abcdef12345');
    expect(youtubeVideoId(new URL('https://youtu.be/abcdef12345'))).toBe('abcdef12345');
  });
  it('uses the main player video, reports ads and the video id', () => {
    document.body.innerHTML = '<div class="html5-video-player ad-showing"></div>';
    const v = video({ time: 12 });
    v.className = 'html5-main-video';
    const c = ctx('https://www.youtube.com/watch?v=abc123XYZ_-');
    // happy-dom window.location is localhost; the adapter reads the id from window.location
    const session = youtubeAdapter.attach(c)!;
    expect(session.getState()).toMatchObject({ timeSeconds: 12, adPlaying: true });
    expect(session.describe()?.src).toBeUndefined();
  });
  it('outranks html5 and is skipped on other sites', () => {
    video();
    expect(resolveAdapter(ctx('https://www.youtube.com/watch?v=abc123XYZ_-')).adapter.id).toBe('youtube');
    expect(resolveAdapter(ctx('https://example.com/')).adapter.id).toBe('html5-video');
  });
});

describe('remotion adapter (fixture captured from a real Remotion Studio 4.0.543)', () => {
  const fx = JSON.parse(readFileSync('tests/fixtures/remotion-studio-4.0.543.json', 'utf8')) as { title: string; pathname: string; localStorageTimeAll: string; draggers: string[] };
  const mount = (opts: { frameButton?: boolean } = {}) => {
    document.title = fx.title;
    const buttons = fx.draggers.filter((h) => opts.frameButton !== false || !/aria-label="\d+"/.test(h));
    document.body.innerHTML = `<div class="remotion-studio-composition-container"></div>${buttons.join('\n')}`;
    document.querySelector('.remotion-studio-composition-container')!.getBoundingClientRect = () => ({ x: 310, y: 116, width: 832, height: 468, left: 310, top: 116, right: 1142, bottom: 584, toJSON() {} }) as DOMRect;
  };
  const storage = (v: string | null) => ({ getItem: () => v }) as unknown as Storage;

  it('fixture sanity: the observed DOM has what the adapter relies on', () => {
    expect(fx.draggers.some((h) => h.includes('aria-label="Frame Rate"'))).toBe(true);
    expect(fx.draggers.some((h) => /aria-label="\d+"/.test(h))).toBe(true);
    expect(JSON.parse(fx.localStorageTimeAll)).toEqual({ Hello: 42 });
  });
  it('detects Studio by title or composition container', () => {
    mount();
    expect(isRemotionStudio(document)).toBe(true);
    document.title = 'Something else';
    expect(isRemotionStudio(document)).toBe(true); // container still there
    document.body.innerHTML = '';
    expect(isRemotionStudio(document)).toBe(false);
  });
  it('strategy 1: live frame from the playhead button aria-label', () => {
    mount();
    const s = readRemotionSnapshot(document, fx.pathname, storage('{"Hello":10}'));
    expect(s).toMatchObject({ compositionId: 'Hello', fps: 30, frame: 42, strategy: 'dragger-aria', persistedFrame: 10, durationFrames: 150, width: 1280, height: 720 });
  });
  it('strategy 2: MM:SS.FF text when the aria-label is not a frame number', () => {
    mount();
    document.querySelectorAll('button').forEach((b) => /^\d+$/.test(b.getAttribute('aria-label') ?? '') && b.setAttribute('aria-label', 'Current time'));
    const s = readRemotionSnapshot(document, fx.pathname, storage(null));
    expect(s).toMatchObject({ frame: 42, strategy: 'dragger-text' });
  });
  it('strategy 3: persisted frame in localStorage when the UI buttons are gone', () => {
    mount({ frameButton: false });
    const s = readRemotionSnapshot(document, fx.pathname, storage(fx.localStorageTimeAll));
    expect(s).toMatchObject({ frame: 42, strategy: 'localStorage' });
  });
  it('returns no frame when nothing is readable (adapter then reports null state)', () => {
    document.body.innerHTML = '';
    expect(readRemotionSnapshot(document, '/Hello', storage(null)).frame).toBeUndefined();
    mount({ frameButton: false });
    const session = remotionAdapter.attach({ url: new URL('http://localhost:3000/Hello'), document, window: { localStorage: storage(null) } as unknown as Window })!;
    expect(session.getState()).toBeNull();
  });
  it('session state: frame authoritative, seconds = frame/fps, paused = live equals persisted', () => {
    mount();
    const w = (ls: string | null) => ({ url: new URL('http://localhost:3000/Hello'), document, window: { localStorage: storage(ls) } as unknown as Window });
    const paused = remotionAdapter.attach(w('{"Hello":42}'))!.getState()!;
    expect(paused).toMatchObject({ frame: 42, fps: 30, paused: true, durationSeconds: 5 });
    expect(paused.timeSeconds).toBeCloseTo(1.4);
    expect(remotionAdapter.attach(w('{"Hello":10}'))!.getState()!.paused).toBe(false); // stale persisted frame => playing
    expect(remotionAdapter.attach(w('{"Hello":42}'))!.getMediaRect()).toMatchObject({ width: 832, height: 468 });
    expect(remotionAdapter.attach(w(null))!.describe()).toMatchObject({ kind: 'composition', compositionId: 'Hello', width: 1280, height: 720 });
  });
  it('composition ids handle nesting and encoding', () => {
    expect(compositionIdFromPath('/Hello')).toBe('Hello');
    expect(compositionIdFromPath('/Folder/My%20Comp/')).toBe('Folder/My Comp');
  });
  it('seek without the MAIN-world bridge fails gracefully (no throw)', async () => {
    mount();
    const win = window;
    const session = remotionAdapter.attach({ url: new URL('http://localhost:3000/Hello'), document, window: win })!;
    const spy = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
    expect(await (session as unknown as { seek(t: unknown): Promise<boolean> }).seek({ seconds: 1, frame: 30 })).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'setFrame', frame: 30, composition: 'Hello' }), '*');
    spy.mockRestore();
  }, 10000);
});

describe('registry', () => {
  it('order: remotion > youtube > html5 > generic', () => {
    expect(defaultAdapters.map((a) => a.id)).toEqual(['remotion', 'youtube', 'html5-video', 'generic']);
  });
  it('falls back to generic when nothing matches', () => {
    const r = resolveAdapter(ctx());
    expect(r.adapter.id).toBe('generic');
    expect(r.session.getState()).toBeNull();
    expect(r.session.getMediaRect()).toBeNull();
    expect(r.session.capabilities).toEqual({ seek: false, pause: false, frameAccurate: false });
  });
  it('a throwing adapter is skipped and logged, never fatal', () => {
    const bad: SiteAdapter = { id: 'remotion', displayName: 'bad', priority: 999, matches: () => true, attach: () => { throw new Error('boom'); } };
    const log = vi.fn();
    video();
    expect(resolveAdapter(ctx(), [bad, ...defaultAdapters], log).adapter.id).toBe('html5-video');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.any(Error));
  });
});
