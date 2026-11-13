import { Html5VideoSession, findBestVideo } from './html5';
import type { AdapterContext, MediaState, SiteAdapter } from './types';
import type { MediaDescriptor } from '../shared/schema';

export function youtubeVideoId(url: URL): string | undefined {
  if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0] || undefined;
  const v = url.searchParams.get('v');
  if (v) return v;
  const m = /^\/(?:shorts|embed|live)\/([\w-]{6,})/.exec(url.pathname);
  return m?.[1];
}

export function isYouTubeUrl(url: URL): boolean {
  const host = url.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtu.be') return true;
  if (host !== 'youtube.com') return false;
  return url.pathname === '/watch' || /^\/(shorts|embed|live)\//.test(url.pathname);
}

/**
 * YouTube: reads/seeks through the page's <video> element (no player-API/MAIN-world dependency).
 * Fragile bits (YouTube-internal class names) fall back to the generic video search.
 */
class YouTubeSession extends Html5VideoSession {
  constructor(private ctx: AdapterContext, video: HTMLVideoElement) {
    super(ctx.document, video);
  }
  private adPlaying(): boolean {
    return !!this.ctx.document.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
  }
  override getState(): MediaState | null {
    const s = super.getState();
    return s ? { ...s, adPlaying: this.adPlaying() } : s;
  }
  override describe(): MediaDescriptor | null {
    const d = super.describe();
    if (!d) return d;
    return { ...d, videoId: youtubeVideoId(new URL(this.ctx.window.location.href)), src: undefined };
  }
}

export const youtubeAdapter: SiteAdapter = {
  id: 'youtube',
  displayName: 'YouTube',
  priority: 50,
  matches: (ctx) => isYouTubeUrl(ctx.url),
  attach(ctx) {
    const v = ctx.document.querySelector<HTMLVideoElement>('video.html5-main-video') ?? findBestVideo(ctx.document);
    return v ? new YouTubeSession(ctx, v) : null;
  },
};
