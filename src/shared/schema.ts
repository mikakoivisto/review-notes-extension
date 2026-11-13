import { z } from 'zod';

export const SCHEMA_VERSION = 1;

import { ADAPTER_IDS, NOTE_STATUSES, NOTE_TYPES, screenshotPath, type ScreenshotKind } from './enums';

export { ADAPTER_IDS, NOTE_STATUSES, NOTE_TYPES, screenshotPath };
export type { ScreenshotKind };

export const NoteTypeSchema = z.enum(NOTE_TYPES);
export const NoteStatusSchema = z.enum(NOTE_STATUSES);
export const AdapterIdSchema = z.enum(ADAPTER_IDS);

const Pt = z.tuple([z.number(), z.number()]);

/** Shapes use coordinates normalised to 0..1 of the anchor rect; `sw` is a fraction of the anchor height. */
export const ShapeSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('pen'), c: z.string(), sw: z.number(), pts: z.array(Pt).min(1) }),
  z.object({ t: z.literal('arrow'), c: z.string(), sw: z.number(), from: Pt, to: Pt }),
  z.object({ t: z.literal('box'), c: z.string(), sw: z.number(), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  z.object({ t: z.literal('circle'), c: z.string(), sw: z.number(), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  z.object({ t: z.literal('text'), c: z.string(), size: z.number(), x: z.number(), y: z.number(), text: z.string() }),
  z.object({ t: z.literal('pin'), c: z.string(), x: z.number(), y: z.number(), label: z.string().optional() }),
]);

export const AnnotationSchema = z.object({
  anchor: z.enum(['media', 'viewport']),
  /** width / height of the anchor rect when drawn */
  aspect: z.number().positive(),
  shapes: z.array(ShapeSchema),
});

export const TimeRefSchema = z.object({
  seconds: z.number().min(0),
  frame: z.number().int().min(0).optional(),
  fps: z.number().positive().optional(),
});

export const MediaDescriptorSchema = z.object({
  kind: z.enum(['video', 'composition']),
  durationSeconds: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  videoId: z.string().optional(),
  compositionId: z.string().optional(),
  src: z.string().optional(),
});

export const ScreenshotRefSchema = z.object({
  annotated: z.string(),
  clean: z.string().optional(),
  width: z.number(),
  height: z.number(),
  crop: z.enum(['media', 'viewport']),
  suspectedBlack: z.boolean(),
});

export const PageContextSchema = z.object({
  scrollX: z.number(),
  scrollY: z.number(),
  viewportWidth: z.number(),
  viewportHeight: z.number(),
  devicePixelRatio: z.number(),
  userAgent: z.string().optional(),
});

export const NoteSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().min(0),
  url: z.string(),
  pageTitle: z.string(),
  adapter: AdapterIdSchema,
  media: MediaDescriptorSchema.nullable(),
  time: TimeRefSchema.nullable(),
  type: NoteTypeSchema,
  text: z.string(),
  status: NoteStatusSchema,
  reply: z.string().optional(),
  annotation: AnnotationSchema.nullable(),
  screenshot: ScreenshotRefSchema.nullable(),
  context: PageContextSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TombstoneSchema = z.object({ id: z.string(), updatedAt: z.string() });

export const NotesFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  exportedAt: z.string().optional(),
  notes: z.array(z.unknown()),
  tombstones: z.array(TombstoneSchema).optional(),
});

export type NoteType = z.infer<typeof NoteTypeSchema>;
export type NoteStatus = z.infer<typeof NoteStatusSchema>;
export type AdapterId = z.infer<typeof AdapterIdSchema>;
export type Shape = z.infer<typeof ShapeSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type TimeRef = z.infer<typeof TimeRefSchema>;
export type MediaDescriptor = z.infer<typeof MediaDescriptorSchema>;
export type ScreenshotRef = z.infer<typeof ScreenshotRefSchema>;
export type PageContext = z.infer<typeof PageContextSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type Tombstone = z.infer<typeof TombstoneSchema>;

export interface NotesFile {
  schemaVersion: typeof SCHEMA_VERSION;
  exportedAt?: string;
  notes: Note[];
  tombstones?: Tombstone[];
}

/** Parse a notes file; invalid notes are skipped and reported instead of failing the whole import. */
export function parseNotesFile(raw: unknown): { notes: Note[]; tombstones: Tombstone[]; skipped: number } {
  const file = NotesFileSchema.safeParse(raw);
  if (!file.success) throw new Error('Not a Review Notes file (missing schemaVersion 1 / notes[])');
  const notes: Note[] = [];
  let skipped = 0;
  for (const n of file.data.notes) {
    const r = NoteSchema.safeParse(n);
    if (r.success) notes.push(r.data);
    else skipped++;
  }
  return { notes, tombstones: file.data.tombstones ?? [], skipped };
}

export function isNoteStatus(v: unknown): v is NoteStatus {
  return typeof v === 'string' && (NOTE_STATUSES as readonly string[]).includes(v);
}
