import { genericAdapter } from './generic';
import { html5Adapter } from './html5';
import { remotionAdapter } from './remotion';
import { youtubeAdapter } from './youtube';
import type { AdapterContext, AdapterSession, SiteAdapter } from './types';

/** Add new adapters here (one file + one line + a fixture test). */
export const defaultAdapters: SiteAdapter[] = [remotionAdapter, youtubeAdapter, html5Adapter, genericAdapter];

export interface Resolved {
  adapter: SiteAdapter;
  session: AdapterSession;
}

/** Highest-priority adapter that matches AND attaches. Exceptions fall through to the next one. */
export function resolveAdapter(ctx: AdapterContext, adapters: SiteAdapter[] = defaultAdapters, log: (m: string, e?: unknown) => void = () => {}): Resolved {
  const sorted = [...adapters].sort((a, b) => b.priority - a.priority);
  for (const adapter of sorted) {
    try {
      if (!adapter.matches(ctx)) continue;
      const session = adapter.attach(ctx);
      if (session) return { adapter, session };
    } catch (e) {
      log(`adapter ${adapter.id} failed`, e);
    }
  }
  return { adapter: genericAdapter, session: genericAdapter.attach(ctx)! };
}

export * from './types';
