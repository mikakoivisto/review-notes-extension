import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { NotesDb } from '../../src/shared/db';
import { makeNote } from './helpers';

let db: NotesDb;
beforeEach(() => {
  db = new NotesDb(new IDBFactory(), 'test');
});
const { seq: _s, ...base } = makeNote();
const blob = (s: string) => new Blob([s], { type: 'image/png' });
const text = (b: Blob | undefined) => b?.text();

describe('NotesDb', () => {
  it('assigns increasing seq and stores blobs atomically', async () => {
    const a = await db.createNote({ ...base, id: 'a' }, { annotated: blob('A'), clean: blob('Ac') });
    const b = await db.createNote({ ...base, id: 'b', createdAt: '2026-01-02T03:04:06.000Z' });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(await text(await db.getScreenshot('a', 'annotated'))).toBe('A');
    expect(await text(await db.getScreenshot('a', 'clean'))).toBe('Ac');
    expect(await db.getScreenshot('b', 'annotated')).toBeUndefined();
    expect((await db.listNotes()).map((n) => n.id)).toEqual(['a', 'b']);
  });
  it('filters by status / url / type', async () => {
    await db.createNote({ ...base, id: 'a', status: 'open' });
    await db.createNote({ ...base, id: 'b', status: 'fixed', url: 'http://other/', type: 'timing' });
    expect((await db.listNotes({ status: 'fixed' })).map((n) => n.id)).toEqual(['b']);
    expect((await db.listNotes({ status: 'all' })).length).toBe(2);
    expect((await db.listNotes({ url: 'http://other/' })).length).toBe(1);
    expect((await db.listNotes({ type: 'timing' })).length).toBe(1);
  });
  it('updateNote bumps updatedAt, can clear reply, and returns undefined for unknown ids', async () => {
    await db.createNote({ ...base, id: 'a' });
    const u = await db.updateNote('a', { text: 'new', status: 'fixed', reply: 'done' }, '2027-01-01T00:00:00.000Z');
    expect(u).toMatchObject({ text: 'new', status: 'fixed', reply: 'done', updatedAt: '2027-01-01T00:00:00.000Z' });
    expect((await db.updateNote('a', { reply: '' }))?.reply).toBeUndefined();
    expect(await db.updateNote('zzz', { text: 'x' })).toBeUndefined();
  });
  it('delete removes note + screenshots and leaves a tombstone', async () => {
    await db.createNote({ ...base, id: 'a' }, { annotated: blob('A') });
    expect(await db.deleteNote('a', '2027-01-01T00:00:00.000Z')).toBe(true);
    expect(await db.getNote('a')).toBeUndefined();
    expect(await db.getScreenshot('a', 'annotated')).toBeUndefined();
    expect(await db.listTombstones()).toEqual([{ id: 'a', updatedAt: '2027-01-01T00:00:00.000Z' }]);
    expect(await db.deleteNote('a')).toBe(false);
  });
  it('mergeNote: adds, updates only when newer, keeps own seq, respects tombstones', async () => {
    const local = await db.createNote({ ...base, id: 'a' });
    const older = { ...local, text: 'older', updatedAt: '2025-01-01T00:00:00.000Z' };
    expect(await db.mergeNote(older)).toBe('kept');
    const newer = { ...local, seq: 99, text: 'newer', updatedAt: '2030-01-01T00:00:00.000Z' };
    expect(await db.mergeNote(newer)).toBe('updated');
    const got = await db.getNote('a');
    expect(got).toMatchObject({ text: 'newer', seq: local.seq });
    // new foreign note: its seq is kept if free, otherwise a fresh one is assigned
    expect(await db.mergeNote(makeNote({ id: 'x', seq: 7 }), { annotated: blob('X') })).toBe('added');
    expect((await db.getNote('x'))?.seq).toBe(7);
    expect(await db.mergeNote(makeNote({ id: 'y', seq: 7 }))).toBe('added');
    expect((await db.getNote('y'))?.seq).toBe(8);
    expect(await text(await db.getScreenshot('x', 'annotated'))).toBe('X');
    // tombstone beats an older incoming note, loses against a newer one
    await db.deleteNote('x', '2031-01-01T00:00:00.000Z');
    expect(await db.mergeNote(makeNote({ id: 'x', updatedAt: '2030-06-01T00:00:00.000Z' }))).toBe('tombstoned');
    expect(await db.mergeNote(makeNote({ id: 'x', updatedAt: '2032-01-01T00:00:00.000Z' }))).toBe('added');
    expect(await db.listTombstones()).toEqual([]);
  });
  it('mergeNote with revive re-adds a deleted note as a newer version (explicit import)', async () => {
    await db.createNote({ ...base, id: 'a' });
    await db.deleteNote('a', '2031-01-01T00:00:00.000Z');
    expect(await db.mergeNote(makeNote({ id: 'a' }), {}, { revive: true })).toBe('added');
    const back = await db.getNote('a');
    expect(back!.updatedAt > '2031-01-01T00:00:00.000Z').toBe(true);
    expect(await db.listTombstones()).toEqual([]);
  });
  it('applyTombstone deletes older local notes but not newer ones', async () => {
    await db.createNote({ ...base, id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(await db.applyTombstone({ id: 'a', updatedAt: '2025-01-01T00:00:00.000Z' })).toBe(false);
    expect(await db.getNote('a')).toBeDefined();
    expect(await db.applyTombstone({ id: 'a', updatedAt: '2027-01-01T00:00:00.000Z' })).toBe(true);
    expect(await db.getNote('a')).toBeUndefined();
  });
  it('meta store round-trips', async () => {
    await db.setMeta('k', { a: 1 });
    expect(await db.getMeta('k')).toEqual({ a: 1 });
    expect(await db.getMeta('none')).toBeUndefined();
  });
});
