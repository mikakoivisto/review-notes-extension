import type { AdapterSession, SiteAdapter } from './types';

class GenericSession implements AdapterSession {
  readonly capabilities = { seek: false, pause: false, frameAccurate: false };
  getState() {
    return null;
  }
  getMediaRect() {
    return null;
  }
  describe() {
    return null;
  }
  async seek() {
    return false;
  }
  pause() {}
  dispose() {}
}

/** Fallback: no media, no time. Notes are page notes (scroll + viewport). */
export const genericAdapter: SiteAdapter = {
  id: 'generic',
  displayName: 'Web page',
  priority: 0,
  matches: () => true,
  attach: () => new GenericSession(),
};
