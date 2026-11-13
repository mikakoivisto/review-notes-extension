import type { AdapterId, MediaDescriptor, TimeRef } from '../shared/schema';

export interface AdapterContext {
  url: URL;
  document: Document;
  window: Window;
}

export interface MediaState {
  timeSeconds: number;
  frame?: number;
  fps?: number;
  durationSeconds?: number;
  paused: boolean;
  /** YouTube: an ad is playing, the timestamp belongs to the ad, not the video */
  adPlaying?: boolean;
}

export interface Capabilities {
  seek: boolean;
  pause: boolean;
  frameAccurate: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AdapterSession {
  readonly capabilities: Capabilities;
  /** Sync and cheap. null when the media vanished or cannot be read. */
  getState(): MediaState | null;
  /** The picture rectangle in viewport CSS pixels (letterbox-aware). */
  getMediaRect(): Rect | null;
  describe(): MediaDescriptor | null;
  /** Resolves true when the position was applied and verified. */
  seek(t: TimeRef): Promise<boolean>;
  pause(): void;
  dispose(): void;
}

export interface SiteAdapter {
  readonly id: AdapterId;
  readonly displayName: string;
  /** Highest matching priority wins. */
  readonly priority: number;
  /** Cheap URL/DOM sniff without side effects. */
  matches(ctx: AdapterContext): boolean;
  attach(ctx: AdapterContext): AdapterSession | null;
}

export function toTimeRef(s: MediaState): TimeRef {
  const t: TimeRef = { seconds: s.timeSeconds };
  if (s.frame !== undefined) t.frame = s.frame;
  if (s.fps !== undefined) t.fps = s.fps;
  return t;
}
