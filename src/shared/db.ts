import type { Note, NoteStatus, NoteType, ScreenshotKind, Tombstone } from './schema';

export type ScreenshotBlobs = Partial<Record<ScreenshotKind, Blob>>;
export type NotePatch = Partial<Pick<Note, 'text' | 'type' | 'status' | 'reply'>>;

const STORES = { notes: 'notes', shots: 'screenshots', tombstones: 'tombstones', meta: 'meta' } as const;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error('transaction aborted'));
  });
}
const shotKey = (id: string, kind: ScreenshotKind) => `${id}/${kind}`;

/** IndexedDB-backed notes store. Holds no in-memory state besides the open connection (safe for MV3 SWs). */
export class NotesDb {
  private dbp: Promise<IDBDatabase> | null = null;
  constructor(private factory: IDBFactory = indexedDB, private name = 'review-notes') {}

  private open(): Promise<IDBDatabase> {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const r = this.factory.open(this.name, 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          const notes = db.createObjectStore(STORES.notes, { keyPath: 'id' });
          notes.createIndex('by-url', 'url');
          notes.createIndex('by-status', 'status');
          notes.createIndex('by-updatedAt', 'updatedAt');
          db.createObjectStore(STORES.shots);
          db.createObjectStore(STORES.tombstones, { keyPath: 'id' });
          db.createObjectStore(STORES.meta);
        };
        r.onsuccess = () => {
          const db = r.result;
          db.onversionchange = () => {
            db.close();
            this.dbp = null;
          };
          resolve(db);
        };
        r.onerror = () => reject(r.error);
      });
    }
    return this.dbp;
  }

  async close(): Promise<void> {
    if (!this.dbp) return;
    (await this.dbp).close();
    this.dbp = null;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    return req(db.transaction(STORES.meta).objectStore(STORES.meta).get(key));
  }
  async setMeta(key: string, value: unknown): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES.meta, 'readwrite');
    tx.objectStore(STORES.meta).put(value, key);
    await done(tx);
  }

  /** Inserts a note (assigning `seq`) together with its screenshot blobs atomically. */
  async createNote(note: Omit<Note, 'seq'>, blobs: ScreenshotBlobs = {}): Promise<Note> {
    const db = await this.open();
    const tx = db.transaction([STORES.notes, STORES.shots, STORES.meta], 'readwrite');
    const meta = tx.objectStore(STORES.meta);
    const seq = ((await req(meta.get('seq'))) as number | undefined ?? 0) + 1;
    meta.put(seq, 'seq');
    const full: Note = { ...note, seq };
    tx.objectStore(STORES.notes).put(full);
    for (const kind of ['annotated', 'clean'] as const) {
      const b = blobs[kind];
      if (b) tx.objectStore(STORES.shots).put(b, shotKey(note.id, kind));
    }
    await done(tx);
    return full;
  }

  async getNote(id: string): Promise<Note | undefined> {
    const db = await this.open();
    return req(db.transaction(STORES.notes).objectStore(STORES.notes).get(id));
  }

  async listNotes(filter: { status?: NoteStatus | 'all'; url?: string; type?: NoteType } = {}): Promise<Note[]> {
    const db = await this.open();
    const all: Note[] = await req(db.transaction(STORES.notes).objectStore(STORES.notes).getAll());
    return all
      .filter((n) => (!filter.status || filter.status === 'all' || n.status === filter.status) && (!filter.url || n.url === filter.url) && (!filter.type || n.type === filter.type))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async updateNote(id: string, patch: NotePatch, now = new Date().toISOString()): Promise<Note | undefined> {
    const db = await this.open();
    const tx = db.transaction(STORES.notes, 'readwrite');
    const store = tx.objectStore(STORES.notes);
    const cur: Note | undefined = await req(store.get(id));
    if (!cur) return undefined;
    const next: Note = { ...cur, ...patch, updatedAt: now };
    if (patch.reply === '') delete next.reply;
    store.put(next);
    await done(tx);
    return next;
  }

  async deleteNote(id: string, now = new Date().toISOString()): Promise<boolean> {
    const db = await this.open();
    const tx = db.transaction([STORES.notes, STORES.shots, STORES.tombstones], 'readwrite');
    const existed = await req(tx.objectStore(STORES.notes).getKey(id));
    if (existed === undefined) return false;
    tx.objectStore(STORES.notes).delete(id);
    tx.objectStore(STORES.shots).delete(shotKey(id, 'annotated'));
    tx.objectStore(STORES.shots).delete(shotKey(id, 'clean'));
    tx.objectStore(STORES.tombstones).put({ id, updatedAt: now } satisfies Tombstone);
    await done(tx);
    return true;
  }

  async getScreenshot(id: string, kind: ScreenshotKind): Promise<Blob | undefined> {
    const db = await this.open();
    return req(db.transaction(STORES.shots).objectStore(STORES.shots).get(shotKey(id, kind)));
  }

  async putScreenshot(id: string, kind: ScreenshotKind, blob: Blob): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES.shots, 'readwrite');
    tx.objectStore(STORES.shots).put(blob, shotKey(id, kind));
    await done(tx);
  }

  async listTombstones(): Promise<Tombstone[]> {
    const db = await this.open();
    return req(db.transaction(STORES.tombstones).objectStore(STORES.tombstones).getAll());
  }

  /**
   * Merge an externally-sourced note (import / companion pull): newer `updatedAt` wins; unknown ids are added.
   * Keeps the existing `seq` when the note already exists; otherwise assigns a fresh one.
   * Returns what happened. Tombstones newer than the incoming note block re-adding it, unless `revive` is set
   * (explicit user import), which re-adds it as a newer version.
   */
  async mergeNote(incoming: Note, blobs: ScreenshotBlobs = {}, opts: { revive?: boolean } = {}): Promise<'added' | 'updated' | 'kept' | 'tombstoned'> {
    const db = await this.open();
    const tx = db.transaction([STORES.notes, STORES.shots, STORES.meta, STORES.tombstones], 'readwrite');
    const notes = tx.objectStore(STORES.notes);
    const cur: Note | undefined = await req(notes.get(incoming.id));
    const tomb: Tombstone | undefined = await req(tx.objectStore(STORES.tombstones).get(incoming.id));
    if (tomb && tomb.updatedAt >= incoming.updatedAt) {
      if (!opts.revive) {
        await done(tx);
        return 'tombstoned';
      }
      // explicit user import of a note they deleted earlier: revive it as a newer version than the tombstone
      incoming = { ...incoming, updatedAt: new Date(Math.max(Date.now(), Date.parse(tomb.updatedAt) + 1)).toISOString() };
    }
    if (cur && cur.updatedAt >= incoming.updatedAt) {
      await done(tx);
      return 'kept';
    }
    let seq = cur?.seq;
    if (seq === undefined) {
      const meta = tx.objectStore(STORES.meta);
      const max = ((await req(meta.get('seq'))) as number | undefined) ?? 0;
      seq = incoming.seq > 0 && !(await this.seqTaken(notes, incoming.seq)) ? incoming.seq : max + 1;
      meta.put(Math.max(max, seq), 'seq');
    }
    notes.put({ ...incoming, seq });
    if (tomb) tx.objectStore(STORES.tombstones).delete(incoming.id);
    for (const kind of ['annotated', 'clean'] as const) {
      const b = blobs[kind];
      if (b) tx.objectStore(STORES.shots).put(b, shotKey(incoming.id, kind));
    }
    await done(tx);
    return cur ? 'updated' : 'added';
  }

  private async seqTaken(store: IDBObjectStore, seq: number): Promise<boolean> {
    const all: Note[] = await req(store.getAll());
    return all.some((n) => n.seq === seq);
  }

  async applyTombstone(t: Tombstone): Promise<boolean> {
    const cur = await this.getNote(t.id);
    if (cur && cur.updatedAt > t.updatedAt) return false;
    if (cur) await this.deleteNote(t.id, t.updatedAt);
    else {
      const db = await this.open();
      const tx = db.transaction(STORES.tombstones, 'readwrite');
      tx.objectStore(STORES.tombstones).put(t);
      await done(tx);
    }
    return true;
  }
}
