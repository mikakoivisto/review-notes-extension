import type { NotesDb } from './db';
import { notesToMarkdown } from './markdown';
import { SCHEMA_VERSION, parseNotesFile, screenshotPath, type Note, type ScreenshotKind } from './schema';
import { readZip, writeZip, type ZipEntry } from './zip';

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface ExportInput {
  notes: Note[];
  getScreenshot(id: string, kind: ScreenshotKind): Promise<Uint8Array | undefined>;
}

/** zip layout == companion store layout: notes.json, notes.md, screenshots/<id>[.clean].png */
export async function buildExportZip(input: ExportInput, exportedAt = new Date().toISOString()): Promise<Uint8Array> {
  const entries: ZipEntry[] = [];
  entries.push({ name: 'notes.json', data: enc.encode(JSON.stringify({ schemaVersion: SCHEMA_VERSION, exportedAt, notes: input.notes }, null, 2)) });
  entries.push({ name: 'notes.md', data: enc.encode(notesToMarkdown(input.notes)) });
  for (const n of input.notes) {
    if (!n.screenshot) continue;
    for (const kind of ['annotated', 'clean'] as const) {
      const data = await input.getScreenshot(n.id, kind);
      if (data) entries.push({ name: screenshotPath(n.id, kind), data });
    }
  }
  return writeZip(entries);
}

export async function exportFromDb(db: NotesDb, notes?: Note[]): Promise<Uint8Array> {
  const list = notes ?? (await db.listNotes());
  return buildExportZip({
    notes: list,
    getScreenshot: async (id, kind) => {
      const b = await db.getScreenshot(id, kind);
      return b ? new Uint8Array(await b.arrayBuffer()) : undefined;
    },
  });
}

export interface ImportResult {
  notes: Note[];
  blobs: Record<string, { annotated?: ArrayBuffer; clean?: ArrayBuffer }>;
  skipped: number;
}

const isZip = (b: Uint8Array) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b;

/** Accepts an export zip or a bare notes.json. */
export async function parseImport(bytes: Uint8Array): Promise<ImportResult> {
  let json: string;
  let files = new Map<string, Uint8Array>();
  if (isZip(bytes)) {
    files = await readZip(bytes);
    const nj = files.get('notes.json');
    if (!nj) throw new Error('The zip has no notes.json');
    json = dec.decode(nj);
  } else {
    json = dec.decode(bytes);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('notes.json is not valid JSON');
  }
  const { notes, skipped } = parseNotesFile(raw);
  const blobs: ImportResult['blobs'] = {};
  for (const n of notes) {
    for (const kind of ['annotated', 'clean'] as const) {
      const path = kind === 'annotated' ? n.screenshot?.annotated : n.screenshot?.clean;
      const data = path ? files.get(path) : undefined;
      if (data) (blobs[n.id] ??= {})[kind] = data.slice().buffer as ArrayBuffer;
    }
  }
  return { notes, blobs, skipped };
}
