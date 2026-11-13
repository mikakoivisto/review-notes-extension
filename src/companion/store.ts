import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { notesToMarkdown } from '../shared/markdown';
import { NoteSchema, SCHEMA_VERSION, parseNotesFile, screenshotPath, type Note, type NoteStatus, type NoteType, type ScreenshotKind, type Tombstone } from '../shared/schema';

export function defaultDir(): string {
  return resolve(process.env.REVIEW_NOTES_DIR || join(homedir(), '.review-notes'));
}

export interface ListFilter {
  status?: NoteStatus | 'all';
  url?: string;
  type?: NoteType;
  adapter?: string;
  limit?: number;
}

interface State {
  notes: Note[];
  tombstones: Tombstone[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * File store: <dir>/notes.json (+ generated notes.md) and <dir>/screenshots/*.png.
 * Shared by the HTTP daemon and any number of stdio MCP processes, so every mutation is
 * lock -> read -> modify -> atomic write (tmp + rename).
 */
export class NoteStore {
  readonly dir: string;
  constructor(dir: string = defaultDir()) {
    this.dir = resolve(dir);
  }
  get notesFile() {
    return join(this.dir, 'notes.json');
  }
  get markdownFile() {
    return join(this.dir, 'notes.md');
  }
  shotFile(id: string, kind: ScreenshotKind) {
    return join(this.dir, screenshotPath(id, kind));
  }

  async read(): Promise<State> {
    try {
      const raw = JSON.parse(await readFile(this.notesFile, 'utf8'));
      const { notes, tombstones } = parseNotesFile(raw);
      return { notes, tombstones };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { notes: [], tombstones: [] };
      throw e;
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true });
    const lock = this.notesFile + '.lock';
    const start = Date.now();
    for (;;) {
      try {
        await mkdir(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          if (Date.now() - (await stat(lock)).mtimeMs > 10_000) await rm(lock, { recursive: true, force: true }); // stale
        } catch {
          /* raced */
        }
        if (Date.now() - start > 8000) throw new Error('Timed out waiting for the notes lock');
        await sleep(25);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  private async write(state: State) {
    const body = { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), notes: state.notes, tombstones: state.tombstones };
    const tmp = `${this.notesFile}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(body, null, 2));
    await rename(tmp, this.notesFile);
    await writeFile(this.markdownFile, notesToMarkdown(state.notes, { title: 'Review notes' }));
  }

  private async mutate<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const state = await this.read();
      const result = await fn(state);
      await this.write(state);
      return result;
    });
  }

  // ---- queries -----------------------------------------------------------------------------------------------
  async list(f: ListFilter = {}): Promise<Note[]> {
    const { notes } = await this.read();
    const status = f.status ?? 'all';
    let out = notes.filter((n) => (status === 'all' || n.status === status) && (!f.url || n.url.includes(f.url)) && (!f.type || n.type === f.type) && (!f.adapter || n.adapter === f.adapter));
    out = out.sort((a, b) => (a.url === b.url ? (a.time?.seconds ?? 1e12) - (b.time?.seconds ?? 1e12) : a.url < b.url ? -1 : 1) || (a.createdAt < b.createdAt ? -1 : 1));
    return f.limit ? out.slice(0, f.limit) : out;
  }

  /** id, "#12" or "12" (seq) */
  async get(ref: string | number): Promise<Note | undefined> {
    const { notes } = await this.read();
    return findNote(notes, ref);
  }

  async index() {
    const { notes, tombstones } = await this.read();
    return {
      dir: this.dir,
      notes: await Promise.all(
        notes.map(async (n) => ({
          id: n.id,
          updatedAt: n.updatedAt,
          shots: (await Promise.all((['annotated', 'clean'] as const).map(async (k) => ((await this.hasShot(n.id, k)) ? k : null)))).filter((k): k is ScreenshotKind => !!k),
        })),
      ),
      tombstones,
    };
  }

  // ---- mutations ---------------------------------------------------------------------------------------------
  /** Extension push. Last-writer-wins on updatedAt. */
  async upsert(input: unknown): Promise<{ note: Note; applied: boolean }> {
    const note = NoteSchema.parse(input);
    return this.mutate((s) => {
      const i = s.notes.findIndex((n) => n.id === note.id);
      const tomb = s.tombstones.find((t) => t.id === note.id);
      if (tomb && tomb.updatedAt >= note.updatedAt) return { note, applied: false };
      if (i >= 0) {
        if (s.notes[i].updatedAt >= note.updatedAt) return { note: s.notes[i], applied: false };
        s.notes[i] = note;
      } else {
        if (!note.seq || s.notes.some((n) => n.seq === note.seq)) note.seq = Math.max(0, ...s.notes.map((n) => n.seq)) + 1;
        s.notes.push(note);
      }
      s.tombstones = s.tombstones.filter((t) => t.id !== note.id);
      return { note, applied: true };
    });
  }

  async remove(id: string, updatedAt = new Date().toISOString()): Promise<boolean> {
    const removed = await this.mutate((s) => {
      const i = s.notes.findIndex((n) => n.id === id);
      if (i >= 0 && s.notes[i].updatedAt > updatedAt) return false;
      if (i >= 0) s.notes.splice(i, 1);
      s.tombstones = [...s.tombstones.filter((t) => t.id !== id), { id, updatedAt }];
      return true;
    });
    if (removed) for (const k of ['annotated', 'clean'] as const) await rm(this.shotFile(id, k), { force: true });
    return removed;
  }

  async setStatus(ref: string | number, status: NoteStatus, reply?: string): Promise<Note> {
    return this.mutate((s) => {
      const n = findNote(s.notes, ref);
      if (!n) throw new Error(`No note matches "${ref}"`);
      n.status = status;
      if (reply !== undefined) n.reply = reply || undefined;
      n.updatedAt = new Date().toISOString();
      return n;
    });
  }

  /** "Take": marks notes in_progress and returns them. */
  async claim(refs?: (string | number)[]): Promise<Note[]> {
    return this.mutate((s) => {
      const targets = refs && refs.length ? refs.map((r) => findNote(s.notes, r)).filter((n): n is Note => !!n) : s.notes.filter((n) => n.status === 'open');
      const now = new Date().toISOString();
      for (const n of targets) {
        if (n.status === 'open') {
          n.status = 'in_progress';
          n.updatedAt = now;
        }
      }
      return targets;
    });
  }

  // ---- screenshots -------------------------------------------------------------------------------------------
  async putShot(id: string, kind: ScreenshotKind, data: Buffer): Promise<void> {
    if (!(data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)) throw new Error('Not a PNG');
    await mkdir(join(this.dir, 'screenshots'), { recursive: true });
    const file = this.shotFile(id, kind);
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }
  async getShot(id: string, kind: ScreenshotKind): Promise<Buffer | undefined> {
    try {
      return await readFile(this.shotFile(id, kind));
    } catch {
      return undefined;
    }
  }
  async hasShot(id: string, kind: ScreenshotKind): Promise<boolean> {
    try {
      await stat(this.shotFile(id, kind));
      return true;
    } catch {
      return false;
    }
  }
}

export function findNote(notes: Note[], ref: string | number): Note | undefined {
  const s = String(ref).trim();
  const byId = notes.find((n) => n.id === s);
  if (byId) return byId;
  const m = /^#?(\d+)$/.exec(s);
  return m ? notes.find((n) => n.seq === Number(m[1])) : undefined;
}
