import type { Annotation, MediaDescriptor, Note, NoteStatus, NoteType, ScreenshotKind, TimeRef, PageContext, AdapterId } from './schema';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureRequest {
  rect: Rect | null;
  innerWidth: number;
}
export interface CaptureResult {
  dataUrl: string;
  width: number;
  height: number;
  crop: 'media' | 'viewport';
  suspectedBlack: boolean;
}

export interface TabState {
  active: boolean;
  adapter: AdapterId;
  adapterName: string;
  title: string;
  url: string;
  time: TimeRef | null;
  paused: boolean | null;
  canSeek: boolean;
  media: MediaDescriptor | null;
  overlayFailed?: string;
}

/** Content-script <- SW/side panel */
export type ContentMessage =
  | { type: 'tab:ping' }
  | { type: 'review:start' }
  | { type: 'review:stop' }
  | { type: 'review:toggle' }
  | { type: 'tab:getState' }
  | { type: 'tab:goto'; note: Pick<Note, 'time' | 'annotation' | 'context' | 'adapter'> };

export interface NewNotePayload {
  note: Omit<Note, 'id' | 'seq' | 'createdAt' | 'updatedAt' | 'screenshot' | 'status'> & { status?: NoteStatus };
  screenshots: { annotated?: CaptureResult; clean?: CaptureResult };
}

/** SW <- content script / side panel / options */
export type SwMessage =
  | { type: 'capture:screenshot'; req: CaptureRequest }
  | { type: 'note:create'; payload: NewNotePayload }
  | { type: 'note:screenshotOnly'; tabId: number; type_?: NoteType; text?: string }
  | { type: 'note:update'; id: string; patch: { text?: string; type?: NoteType; status?: NoteStatus; reply?: string } }
  | { type: 'note:delete'; id: string }
  | { type: 'note:goto'; id: string; tabId: number }
  | { type: 'review:start'; tabId: number }
  | { type: 'review:stop'; tabId: number }
  | { type: 'review:toggle'; tabId: number }
  | { type: 'tab:getState'; tabId: number }
  | { type: 'bridge:ensure' }
  | { type: 'import:notes'; notes: Note[]; blobs: Record<string, { annotated?: ArrayBuffer; clean?: ArrayBuffer }> }
  | { type: 'sync:now' }
  | { type: 'sync:status' }
  | { type: 'tabs:lastWeb' };

export interface SwReply<T = unknown> {
  ok: boolean;
  error?: string;
  code?: string;
  data?: T;
}

export const NOTES_CHANGED = 'notes-changed' as const;

export function screenshotKinds(): ScreenshotKind[] {
  return ['annotated', 'clean'];
}

export type { Annotation, PageContext };
