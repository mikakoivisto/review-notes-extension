import type { Note } from '../../src/shared/schema';

export function makeNote(over: Partial<Note> = {}): Note {
  const now = '2026-01-02T03:04:05.000Z';
  return {
    id: 'n1',
    seq: 1,
    url: 'http://localhost/video.html',
    pageTitle: 'Video page',
    adapter: 'html5-video',
    media: { kind: 'video', durationSeconds: 8, width: 640, height: 360 },
    time: { seconds: 3 },
    type: 'visual',
    text: 'Logo too small',
    status: 'open',
    annotation: { anchor: 'media', aspect: 16 / 9, shapes: [{ t: 'box', c: '#ef4444', sw: 0.006, x: 0.1, y: 0.1, w: 0.3, h: 0.2 }] },
    screenshot: { annotated: 'screenshots/n1.png', clean: 'screenshots/n1.clean.png', width: 800, height: 450, crop: 'media', suspectedBlack: false },
    context: { scrollX: 0, scrollY: 0, viewportWidth: 1100, viewportHeight: 760, devicePixelRatio: 1 },
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** 1x1 transparent PNG */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
