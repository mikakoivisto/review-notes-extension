import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildExportZip, parseImport } from '../../src/shared/export';
import { notesToMarkdown } from '../../src/shared/markdown';
import { crc32, readZip, writeZip } from '../../src/shared/zip';
import { PNG, makeNote } from './helpers';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('zip', () => {
  it('crc32 matches the reference value', () => expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926));
  it('round-trips stored entries including utf-8 names', async () => {
    const z = writeZip([{ name: 'a.txt', data: enc.encode('hello') }, { name: 'dir/ü.bin', data: new Uint8Array([1, 2, 3, 255]) }]);
    const m = await readZip(z);
    expect(dec.decode(m.get('a.txt'))).toBe('hello');
    expect([...m.get('dir/ü.bin')!]).toEqual([1, 2, 3, 255]);
  });
  it('reads deflate-compressed entries made by other tools', async () => {
    const stored = writeZip([{ name: 'x.txt', data: enc.encode('x') }]);
    // craft a deflate entry by patching method + sizes of a stored zip
    const body = enc.encode('compress me compress me compress me');
    const comp = deflateRawSync(body);
    const name = enc.encode('c.txt');
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, 8, true);
    lh.setUint32(14, crc32(body), true); lh.setUint32(18, comp.length, true); lh.setUint32(22, body.length, true); lh.setUint16(26, name.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(10, 8, true);
    ch.setUint32(16, crc32(body), true); ch.setUint32(20, comp.length, true); ch.setUint32(24, body.length, true); ch.setUint16(28, name.length, true);
    const end = new DataView(new ArrayBuffer(22));
    const localLen = 30 + name.length + comp.length;
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true); end.setUint32(12, 46 + name.length, true); end.setUint32(16, localLen, true);
    const zip = Buffer.concat([new Uint8Array(lh.buffer), name, comp, new Uint8Array(ch.buffer), name, new Uint8Array(end.buffer)]);
    const m = await readZip(new Uint8Array(zip));
    expect(dec.decode(m.get('c.txt'))).toBe(dec.decode(body));
    expect(stored.length).toBeGreaterThan(0);
  });
  it('rejects garbage', async () => {
    await expect(readZip(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(/zip/i);
  });
});

describe('export / import', () => {
  const notes = [makeNote(), makeNote({ id: 'n2', seq: 2, time: { seconds: 1.4, frame: 42, fps: 30 }, text: 'Second', screenshot: { annotated: 'screenshots/n2.png', width: 1, height: 1, crop: 'viewport', suspectedBlack: true } })];
  const shots: Record<string, Uint8Array> = { 'n1/annotated': PNG, 'n1/clean': PNG, 'n2/annotated': PNG };
  const getScreenshot = async (id: string, kind: string) => shots[`${id}/${kind}`];

  it('zip has notes.json, notes.md and screenshots', async () => {
    const files = await readZip(await buildExportZip({ notes, getScreenshot }, '2026-01-01T00:00:00Z'));
    expect([...files.keys()].sort()).toEqual(['notes.json', 'notes.md', 'screenshots/n1.clean.png', 'screenshots/n1.png', 'screenshots/n2.png']);
    expect(JSON.parse(dec.decode(files.get('notes.json'))).notes).toHaveLength(2);
    expect(dec.decode(files.get('notes.md'))).toContain('frame 42');
  });
  it('round-trips through parseImport with screenshots', async () => {
    const r = await parseImport(await buildExportZip({ notes, getScreenshot }));
    expect(r.notes).toEqual(notes);
    expect(r.skipped).toBe(0);
    expect(Buffer.from(r.blobs.n1.annotated!).equals(PNG)).toBe(true);
    expect(r.blobs.n2.clean).toBeUndefined();
  });
  it('imports a bare notes.json and skips invalid notes', async () => {
    const json = JSON.stringify({ schemaVersion: 1, notes: [notes[0], { nope: true }] });
    const r = await parseImport(enc.encode(json));
    expect(r.notes).toHaveLength(1);
    expect(r.skipped).toBe(1);
    expect(r.blobs).toEqual({});
  });
  it('rejects non-JSON and foreign zips', async () => {
    await expect(parseImport(enc.encode('not json'))).rejects.toThrow(/JSON/);
    await expect(parseImport(writeZip([{ name: 'other.txt', data: enc.encode('x') }]))).rejects.toThrow(/notes\.json/);
  });
});

describe('markdown', () => {
  it('renders sections, timecodes, replies, screenshots and the black warning', () => {
    const md = notesToMarkdown([
      makeNote({ reply: 'Enlarged logo' }),
      makeNote({ id: 'n2', seq: 2, time: { seconds: 1.4, frame: 42, fps: 30 }, adapter: 'remotion', media: { kind: 'composition', compositionId: 'Hello' }, screenshot: { annotated: 'screenshots/n2.png', width: 1, height: 1, crop: 'media', suspectedBlack: true } }),
    ]);
    expect(md).toContain('### #2 · visual · open · 00:01.40 · frame 42');
    expect(md).toContain('composition `Hello`');
    expect(md).toContain('**Reply:** Enlarged logo');
    expect(md).toContain('![note 1](screenshots/n1.png)');
    expect(md).toContain('looks black');
    // sorted by media time: #2 (1.4s) before #1 (3s)
    expect(md.indexOf('#2')).toBeLessThan(md.indexOf('#1'));
  });
  it('handles an empty list', () => expect(notesToMarkdown([])).toContain('No notes'));
});
