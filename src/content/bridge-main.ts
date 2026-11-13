/**
 * MAIN-world bridge, injected only on Remotion Studio pages (see adapters/remotion.ts).
 * Isolated-world content scripts cannot see page globals such as window.remotion_setFrame; this script
 * exposes exactly one capability (seek) over window.postMessage. It cannot do anything the page itself
 * could not already do.
 */
import { BRIDGE_SOURCE_BRIDGE, BRIDGE_SOURCE_CONTENT } from '../adapters/bridge-protocol';

declare global {
  interface Window {
    __reviewNotesBridge?: boolean;
    remotion_setFrame?: (frame: number, composition: string, attempt?: number) => void;
  }
}

if (!window.__reviewNotesBridge) {
  window.__reviewNotesBridge = true;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== BRIDGE_SOURCE_CONTENT) return;
    let ok = false;
    if (d.cmd === 'setFrame' && typeof window.remotion_setFrame === 'function' && Number.isFinite(d.frame)) {
      try {
        window.remotion_setFrame(Math.max(0, Math.round(d.frame)), String(d.composition ?? ''));
        ok = true;
      } catch {
        ok = false;
      }
    } else if (d.cmd === 'ping') {
      ok = true;
    }
    window.postMessage({ source: BRIDGE_SOURCE_BRIDGE, id: d.id, ok }, '*');
  });
}
