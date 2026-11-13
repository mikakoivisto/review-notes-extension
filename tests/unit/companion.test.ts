import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXTENSION_ORIGIN } from '../../src/shared/constants';
import { createHttpServer, listen } from '../../src/companion/http';
import { createMcpServer } from '../../src/companion/mcp';
import { NoteStore } from '../../src/companion/store';
import { PNG, makeNote } from './helpers';

let dir: string;
let store: NoteStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rn-store-'));
  store = new NoteStore(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('NoteStore (file store)', () => {
  it('writes notes.json + notes.md and reads them back; missing dir = empty', async () => {
    expect((await new NoteStore(join(dir, 'nope')).read()).notes).toEqual([]);
    await store.upsert(makeNote());
    expect(JSON.parse(readFileSync(store.notesFile, 'utf8'))).toMatchObject({ schemaVersion: 1, notes: [{ id: 'n1' }] });
    expect(readFileSync(store.markdownFile, 'utf8')).toContain('### #1 · visual · open');
  });
  it('upsert is last-writer-wins on updatedAt and honours tombstones', async () => {
    await store.upsert(makeNote({ text: 'v1', updatedAt: '2026-01-01T00:00:00.000Z' }));
    expect((await store.upsert(makeNote({ text: 'old', updatedAt: '2025-01-01T00:00:00.000Z' }))).applied).toBe(false);
    expect((await store.upsert(makeNote({ text: 'v2', updatedAt: '2027-01-01T00:00:00.000Z' }))).applied).toBe(true);
    expect((await store.get('n1'))?.text).toBe('v2');
    await store.remove('n1', '2028-01-01T00:00:00.000Z');
    expect(await store.get('n1')).toBeUndefined();
    expect((await store.upsert(makeNote({ updatedAt: '2027-06-01T00:00:00.000Z' }))).applied).toBe(false);
    expect((await store.index()).tombstones).toHaveLength(1);
  });
  it('rejects invalid notes', async () => {
    await expect(store.upsert({ id: 'x' })).rejects.toThrow();
  });
  it('get accepts id, "#seq" and "seq"; status changes bump updatedAt', async () => {
    await store.upsert(makeNote({ id: 'abc', seq: 4 }));
    expect((await store.get('#4'))?.id).toBe('abc');
    expect((await store.get('4'))?.id).toBe('abc');
    expect((await store.get(4))?.id).toBe('abc');
    const before = (await store.get('abc'))!.updatedAt;
    const n = await store.setStatus('#4', 'fixed', 'done');
    expect(n).toMatchObject({ status: 'fixed', reply: 'done' });
    expect(n.updatedAt > before).toBe(true);
    await expect(store.setStatus('#99', 'fixed')).rejects.toThrow(/No note/);
  });
  it('list filters and sorts by url then media time', async () => {
    await store.upsert(makeNote({ id: 'b', seq: 2, time: { seconds: 9 } }));
    await store.upsert(makeNote({ id: 'a', seq: 1, time: { seconds: 2 }, status: 'fixed' }));
    await store.upsert(makeNote({ id: 'c', seq: 3, time: null, url: 'http://other/x', type: 'general', adapter: 'generic' }));
    expect((await store.list({ status: 'all' })).map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect((await store.list({ status: 'open' })).map((n) => n.id)).toEqual(['b', 'c']);
    expect((await store.list({ status: 'all', url: 'other' })).map((n) => n.id)).toEqual(['c']);
    expect((await store.list({ status: 'all', adapter: 'generic' })).length).toBe(1);
    expect((await store.list({ status: 'all', limit: 1 })).length).toBe(1);
  });
  it('claim marks only open notes in_progress', async () => {
    await store.upsert(makeNote({ id: 'a', seq: 1 }));
    await store.upsert(makeNote({ id: 'b', seq: 2, status: 'fixed' }));
    expect((await store.claim()).map((n) => n.id)).toEqual(['a']);
    expect((await store.get('a'))?.status).toBe('in_progress');
    expect((await store.get('b'))?.status).toBe('fixed');
  });
  it('screenshots: PNG only, index lists them, remove deletes files', async () => {
    await store.upsert(makeNote());
    await expect(store.putShot('n1', 'annotated', Buffer.from('not a png'))).rejects.toThrow(/PNG/);
    await store.putShot('n1', 'annotated', PNG);
    expect((await store.index()).notes[0].shots).toEqual(['annotated']);
    expect((await store.getShot('n1', 'annotated'))?.equals(PNG)).toBe(true);
    await store.remove('n1');
    expect(existsSync(store.shotFile('n1', 'annotated'))).toBe(false);
  });
  it('concurrent writers (two store instances) never lose updates', async () => {
    const other = new NoteStore(dir);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : other).upsert(makeNote({ id: `n${i}`, seq: i + 1 }))));
    expect((await store.list({ status: 'all' })).length).toBe(20);
  });
  it('recovers from a stale lock', async () => {
    const { mkdirSync, utimesSync } = await import('node:fs');
    mkdirSync(store.notesFile + '.lock', { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(store.notesFile + '.lock', old, old);
    await store.upsert(makeNote());
    expect((await store.list({ status: 'all' })).length).toBe(1);
  });
});

describe('HTTP API security + sync endpoints', () => {
  let server: Server;
  let port: number;
  let base: string;
  beforeAll(async () => {
    server = createHttpServer({ store: new NoteStore(mkdtempSync(join(tmpdir(), 'rn-http-'))) });
    port = await listen(server, 0);
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const ext = { origin: EXTENSION_ORIGIN, 'content-type': 'application/json' };

  it('allows the pinned extension origin and answers preflight', async () => {
    const h = await fetch(`${base}/api/health`, { headers: ext });
    expect(h.status).toBe(200);
    expect(h.headers.get('access-control-allow-origin')).toBe(EXTENSION_ORIGIN);
    expect(await h.json()).toMatchObject({ ok: true });
    const pre = await fetch(`${base}/api/notes/x`, { method: 'OPTIONS', headers: { origin: EXTENSION_ORIGIN } });
    expect(pre.status).toBe(204);
  });
  it('accepts Origin-less GETs only when the browser says they are extension/user initiated (Sec-Fetch-Site: none)', async () => {
    // observed: Chrome extension contexts omit Origin on simple GETs and send Sec-Fetch-Site: none
    expect((await fetch(`${base}/api/health`, { headers: { 'sec-fetch-site': 'none' } })).status).toBe(200);
    // a web page doing a no-cors GET: no Origin, but the browser marks it cross-site
    expect((await fetch(`${base}/api/health`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await fetch(`${base}/api/health`, { headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);
  });
  it('rejects web-page origins and header-less clients on /api', async () => {
    expect((await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'none' } })).status).toBe(403);
    expect((await fetch(`${base}/api/health`)).status).toBe(403);
    expect((await fetch(`${base}/api/health`, { headers: { origin: 'chrome-extension://someotherextensionidxxxxxxxxxxx' } })).status).toBe(403);
  });
  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolveP) => {
      const r = request({ host: '127.0.0.1', port, path: '/api/health', headers: { host: 'evil.example', origin: EXTENSION_ORIGIN } }, (res) => resolveP(res.statusCode ?? 0));
      r.end();
    });
    expect(status).toBe(403);
  });
  it('/mcp rejects browser origins and non-POST', async () => {
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });
  it('unknown routes 404; bad ids 400; mismatched ids 400', async () => {
    expect((await fetch(`${base}/api/nope`, { headers: ext })).status).toBe(404);
    expect((await fetch(`${base}/api/notes/..%2Fetc`, { headers: ext })).status).toBe(400);
    expect((await fetch(`${base}/api/notes/n1`, { method: 'PUT', headers: ext, body: JSON.stringify(makeNote({ id: 'other' })) })).status).toBe(400);
  });
  it('sync round trip: put note + screenshot, index, get, delete -> tombstone', async () => {
    expect((await fetch(`${base}/api/notes/n1`, { method: 'PUT', headers: ext, body: JSON.stringify(makeNote()) })).status).toBe(200);
    expect((await fetch(`${base}/api/notes/n1/screenshot/annotated`, { method: 'PUT', headers: { origin: EXTENSION_ORIGIN, 'content-type': 'image/png' }, body: PNG })).status).toBe(200);
    expect((await fetch(`${base}/api/notes/n1/screenshot/bogus`, { method: 'PUT', headers: ext, body: PNG })).status).toBe(400);
    const idx = await (await fetch(`${base}/api/sync/index`, { headers: ext })).json();
    expect(idx.notes).toEqual([{ id: 'n1', updatedAt: makeNote().updatedAt, shots: ['annotated'] }]);
    const shot = await fetch(`${base}/api/notes/n1/screenshot/annotated`, { headers: ext });
    expect(Buffer.from(await shot.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await (await fetch(`${base}/api/notes/n1`, { headers: ext })).json()).text).toBe('Logo too small');
    expect((await fetch(`${base}/api/notes/n1`, { method: 'DELETE', headers: ext, body: JSON.stringify({ updatedAt: '2030-01-01T00:00:00.000Z' }) })).status).toBe(200);
    expect((await fetch(`${base}/api/notes/n1`, { headers: ext })).status).toBe(404);
    expect((await (await fetch(`${base}/api/sync/index`, { headers: ext })).json()).tombstones).toHaveLength(1);
  });
  it('refuses oversized MCP bodies', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(3 * 1024 * 1024) }).catch(() => null);
    expect(res === null || res.status === 413).toBe(true);
  });
});

describe('MCP server', () => {
  async function seeded() {
    await store.upsert(makeNote({ id: 'n1', seq: 1 }));
    await store.upsert(makeNote({ id: 'n2', seq: 2, time: { seconds: 1.4, frame: 42, fps: 30 }, adapter: 'remotion', text: 'Remotion frame note', screenshot: { annotated: 'screenshots/n2.png', width: 1, height: 1, crop: 'viewport', suspectedBlack: true } }));
    await store.putShot('n2', 'annotated', PNG);
  }
  const text = (r: unknown) => ((r as { content: { type: string; text: string }[] }).content).find((c) => c.type === 'text')!.text;

  it('in-memory client: tools, list/get/screenshot/update/mark_fixed/claim', async () => {
    await seeded();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(store).connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['claim_notes', 'get_note', 'get_screenshot', 'list_notes', 'mark_fixed', 'update_note_status']);

    const list = await client.callTool({ name: 'list_notes', arguments: {} });
    expect(text(list)).toContain('#1 [open] visual 00:03.00');
    expect(text(list)).toContain('#2 [open] visual 00:01.40 · frame 42');
    expect((await client.callTool({ name: 'list_notes', arguments: { adapter: 'remotion' } })).structuredContent).toMatchObject({ notes: [{ id: 'n2' }] });

    expect(text(await client.callTool({ name: 'get_note', arguments: { id: '#2' } }))).toContain('WARNING: the screenshot looks black');
    const shot = await client.callTool({ name: 'get_screenshot', arguments: { id: 'n2' } });
    const img = (shot.content as { type: string; data?: string; mimeType?: string }[]).find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data!, 'base64').equals(PNG)).toBe(true);
    expect((await client.callTool({ name: 'get_screenshot', arguments: { id: 'n1' } })).isError).toBe(true);

    expect(text(await client.callTool({ name: 'claim_notes', arguments: { ids: ['n1'] } }))).toContain('Claimed 1');
    expect((await store.get('n1'))?.status).toBe('in_progress');
    expect(text(await client.callTool({ name: 'mark_fixed', arguments: { id: '1', reply: 'Enlarged logo' } }))).toBe('#1 → fixed · Enlarged logo');
    expect((await store.get('n1'))).toMatchObject({ status: 'fixed', reply: 'Enlarged logo' });
    expect(text(await client.callTool({ name: 'update_note_status', arguments: { id: 'n1', status: 'open' } }))).toContain('→ open');
    expect((await client.callTool({ name: 'mark_fixed', arguments: { id: 'missing' } })).isError).toBe(true);
    expect(text(await client.callTool({ name: 'list_notes', arguments: { status: 'fixed' } }))).toMatch(/No fixed notes/);
    await client.close();
  });

  it('real stdio process (built CLI): sees the same files the daemon writes', async () => {
    const cli = resolve('dist/companion/cli.js');
    if (!existsSync(cli)) throw new Error('run `npm run build` first (npm test does)');
    await seeded();
    const client = new Client({ name: 'stdio', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--dir', dir] }));
    expect(text(await client.callTool({ name: 'list_notes', arguments: { status: 'all' } }))).toContain('Remotion frame note');
    await client.callTool({ name: 'mark_fixed', arguments: { id: '#2', reply: 'via stdio' } });
    await client.close();
    expect(await store.get('n2')).toMatchObject({ status: 'fixed', reply: 'via stdio' }); // another process wrote it
  });

  it('real HTTP daemon (built CLI) serves MCP over streamable HTTP', async () => {
    const cli = resolve('dist/companion/cli.js');
    await seeded();
    const child = spawn(process.execPath, [cli, 'serve', '--dir', dir, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const url = await new Promise<string>((res, rej) => {
        const t = setTimeout(() => rej(new Error('daemon did not start')), 10_000);
        child.stdout.on('data', (d: Buffer) => {
          const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d));
          if (m) {
            clearTimeout(t);
            res(m[1]);
          }
        });
        child.on('exit', () => rej(new Error('daemon exited')));
      });
      const client = new Client({ name: 'http', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      expect(text(await client.callTool({ name: 'list_notes', arguments: {} }))).toContain('#1 [open]');
      await client.callTool({ name: 'mark_fixed', arguments: { id: 'n1', reply: 'via http' } });
      await client.close();
      expect((await store.get('n1'))?.reply).toBe('via http');
    } finally {
      child.kill('SIGTERM');
    }
  });
});
