import { describe, expect, it } from 'vitest';
import { NoteSchema, parseNotesFile, screenshotPath } from '../../src/shared/schema';
import { formatSeconds, formatTime, parseFps, remotionTimecodeToFrame } from '../../src/shared/time';
import { newId } from '../../src/shared/ids';
import { makeNote } from './helpers';

describe('schema', () => {
  it('accepts a valid note and every shape type', () => {
    const shapes = [
      { t: 'pen', c: '#fff', sw: 0.01, pts: [[0, 0], [1, 1]] },
      { t: 'arrow', c: '#fff', sw: 0.01, from: [0, 0], to: [1, 1] },
      { t: 'box', c: '#fff', sw: 0.01, x: 0, y: 0, w: 1, h: 1 },
      { t: 'circle', c: '#fff', sw: 0.01, x: 0, y: 0, w: 1, h: 1 },
      { t: 'text', c: '#fff', size: 0.04, x: 0.5, y: 0.5, text: 'hi' },
      { t: 'pin', c: '#fff', x: 0.5, y: 0.5, label: '1' },
    ];
    const n = makeNote({ annotation: { anchor: 'viewport', aspect: 1.5, shapes } as never });
    expect(NoteSchema.safeParse(n).success).toBe(true);
  });
  it('rejects bad status, bad shape and missing fields', () => {
    expect(NoteSchema.safeParse({ ...makeNote(), status: 'done' }).success).toBe(false);
    expect(NoteSchema.safeParse({ ...makeNote(), annotation: { anchor: 'media', aspect: 1, shapes: [{ t: 'star' }] } }).success).toBe(false);
    const { text: _t, ...rest } = makeNote();
    expect(NoteSchema.safeParse(rest).success).toBe(false);
  });
  it('parseNotesFile skips invalid notes and reports them', () => {
    const r = parseNotesFile({ schemaVersion: 1, notes: [makeNote(), { id: 'bad' }, makeNote({ id: 'n2', seq: 2 })] });
    expect(r.notes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(r.skipped).toBe(1);
  });
  it('parseNotesFile rejects foreign files', () => {
    expect(() => parseNotesFile({ hello: 1 })).toThrow(/Review Notes file/);
    expect(() => parseNotesFile({ schemaVersion: 2, notes: [] })).toThrow();
  });
  it('screenshot paths', () => {
    expect(screenshotPath('abc', 'annotated')).toBe('screenshots/abc.png');
    expect(screenshotPath('abc', 'clean')).toBe('screenshots/abc.clean.png');
  });
});

describe('time', () => {
  it('formats seconds', () => {
    expect(formatSeconds(0)).toBe('00:00.00');
    expect(formatSeconds(12.4)).toBe('00:12.40');
    expect(formatSeconds(65.05)).toBe('01:05.05');
    expect(formatSeconds(3723.5)).toBe('1:02:03.50');
    expect(formatSeconds(-3)).toBe('00:00.00');
  });
  it('formats with frame', () => {
    expect(formatTime({ seconds: 1.4, frame: 42, fps: 30 })).toBe('00:01.40 · frame 42');
    expect(formatTime({ seconds: 3 })).toBe('00:03.00');
    expect(formatTime(null)).toBe('');
  });
  it('parses fps and remotion timecodes', () => {
    expect(parseFps('30fps')).toBe(30);
    expect(parseFps('29.97 fps')).toBe(29.97);
    expect(parseFps('nope')).toBeUndefined();
    expect(remotionTimecodeToFrame('00:01.12', 30)).toBe(42);
    expect(remotionTimecodeToFrame('00:05.00', 30)).toBe(150);
    expect(remotionTimecodeToFrame('1:00:00.00', 30)).toBe(108000);
    expect(remotionTimecodeToFrame('garbage', 30)).toBeUndefined();
  });
});

describe('ids', () => {
  it('are sortable by time and unique-ish', () => {
    const a = newId(1000, () => 0.1);
    const b = newId(2000, () => 0.1);
    expect(a < b).toBe(true);
    expect(newId()).not.toBe(newId());
    expect(newId()).toMatch(/^[0-9a-z]{17}$/);
  });
});
