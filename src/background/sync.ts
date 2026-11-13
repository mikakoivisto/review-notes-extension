import { NotesDb } from '../shared/db';
import { NoteSchema, type Note, type ScreenshotKind } from '../shared/schema';

export interface Settings {
  syncEnabled: boolean;
  companionUrl: string;
}
export const DEFAULT_SETTINGS: Settings = { syncEnabled: false, companionUrl: 'http://127.0.0.1:47821' };

export interface SyncStatus {
  state: 'off' | 'ok' | 'error';
  lastSync?: string;
  error?: string;
  remoteNotes?: number;
  dir?: string;
}

export async function getSettings(): Promise<Settings> {
  const s = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(s.settings ?? {}) };
}
export async function getSyncStatus(): Promise<SyncStatus> {
  const s = await chrome.storage.session.get('syncStatus');
  return (s.syncStatus as SyncStatus | undefined) ?? { state: 'off' };
}
async function setSyncStatus(st: SyncStatus) {
  await chrome.storage.session.set({ syncStatus: st });
}

interface RemoteIndex {
  notes: { id: string; updatedAt: string; shots: ScreenshotKind[] }[];
  tombstones: { id: string; updatedAt: string }[];
  dir: string;
}

async function http(base: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(base.replace(/\/$/, '') + path, init);
  if (!res.ok) throw new Error(`companion ${init?.method ?? 'GET'} ${path}: HTTP ${res.status}`);
  return res;
}

/**
 * Stateless reconciliation (idempotent, safe to run any time): compare local and remote indexes; per note,
 * last-writer-wins on updatedAt. Screenshots are immutable, so they are transferred only when missing.
 */
export async function syncOnce(db: NotesDb): Promise<SyncStatus> {
  const settings = await getSettings();
  if (!settings.syncEnabled) {
    const st: SyncStatus = { state: 'off' };
    await setSyncStatus(st);
    return st;
  }
  const base = settings.companionUrl;
  try {
    const remote: RemoteIndex = await (await http(base, '/api/sync/index')).json();
    const rNotes = new Map(remote.notes.map((n) => [n.id, n]));
    const rTombs = new Map(remote.tombstones.map((t) => [t.id, t]));
    const local = await db.listNotes();
    const lTombs = await db.listTombstones();
    let changed = false;

    // tombstones: remote -> local
    for (const t of remote.tombstones) if (await db.applyTombstone(t)) changed = true;
    // tombstones: local -> remote
    for (const t of lTombs) {
      const r = rTombs.get(t.id);
      if (!r || r.updatedAt < t.updatedAt) {
        await http(base, `/api/notes/${t.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updatedAt: t.updatedAt }) });
      }
    }

    const localIds = new Set<string>();
    for (const n of local) {
      localIds.add(n.id);
      const r = rNotes.get(n.id);
      if (rTombs.has(n.id) && rTombs.get(n.id)!.updatedAt >= n.updatedAt) continue;
      if (!r || r.updatedAt < n.updatedAt) {
        await http(base, `/api/notes/${n.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(n) });
        for (const kind of ['annotated', 'clean'] as const) {
          if (r?.shots.includes(kind)) continue;
          const blob = await db.getScreenshot(n.id, kind);
          if (blob) await http(base, `/api/notes/${n.id}/screenshot/${kind}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: blob });
        }
      } else if (r.updatedAt > n.updatedAt) {
        await pull(db, base, n.id, r.shots);
        changed = true;
      } else {
        // same version: make sure screenshots exist on both sides
        for (const kind of ['annotated', 'clean'] as const) {
          const blob = await db.getScreenshot(n.id, kind);
          if (blob && !r.shots.includes(kind)) await http(base, `/api/notes/${n.id}/screenshot/${kind}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: blob });
          if (!blob && r.shots.includes(kind)) {
            await pullShot(db, base, n.id, kind);
            changed = true;
          }
        }
      }
    }
    // remote-only notes
    for (const r of remote.notes) {
      if (localIds.has(r.id)) continue;
      const tomb = lTombs.find((t) => t.id === r.id);
      if (tomb && tomb.updatedAt >= r.updatedAt) continue;
      await pull(db, base, r.id, r.shots);
      changed = true;
    }
    const st: SyncStatus = { state: 'ok', lastSync: new Date().toISOString(), remoteNotes: remote.notes.length, dir: remote.dir };
    await setSyncStatus(st);
    if (changed) void chrome.runtime.sendMessage({ type: 'notes-changed' }).catch(() => {});
    return st;
  } catch (e) {
    const st: SyncStatus = { state: 'error', error: e instanceof Error ? e.message : String(e), lastSync: (await getSyncStatus()).lastSync };
    await setSyncStatus(st);
    return st;
  }
}

async function pull(db: NotesDb, base: string, id: string, shots: ScreenshotKind[]) {
  const parsed = NoteSchema.safeParse(await (await http(base, `/api/notes/${id}`)).json());
  if (!parsed.success) return;
  const note: Note = parsed.data;
  const blobs: Partial<Record<ScreenshotKind, Blob>> = {};
  for (const kind of shots) blobs[kind] = await (await http(base, `/api/notes/${id}/screenshot/${kind}`)).blob();
  await db.mergeNote(note, blobs);
}
async function pullShot(db: NotesDb, base: string, id: string, kind: ScreenshotKind) {
  await db.putScreenshot(id, kind, await (await http(base, `/api/notes/${id}/screenshot/${kind}`)).blob());
}
