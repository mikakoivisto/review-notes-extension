import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { EXTENSION_ORIGIN } from '../shared/constants';
import { createMcpServer, SERVER_VERSION } from './mcp';
import type { NoteStore } from './store';

export interface HttpOptions {
  store: NoteStore;
  /** extra browser origins allowed on /api (the pinned extension origin is always allowed) */
  allowedOrigins?: string[];
}

const MAX_API_BODY = 25 * 1024 * 1024;
const MAX_MCP_BODY = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isBuf ? 'image/png' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}

/**
 * Local HTTP server: extension API (/api/*) and MCP streamable HTTP (/mcp).
 * Security: callers must bind to 127.0.0.1; Host header must be loopback (DNS rebinding);
 * /api/* needs the pinned extension Origin; /mcp rejects any browser Origin.
 */
export function createHttpServer(opts: HttpOptions): Server {
  const { store } = opts;
  const allowedOrigins = new Set([EXTENSION_ORIGIN, ...(opts.allowedOrigins ?? [])]);
  let server: Server;

  const hostOk = (host: string | undefined) => {
    const port = (server.address() as AddressInfo | null)?.port;
    return !!host && !!port && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
  };

  server = createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host)) throw new HttpError(403, 'Bad Host header');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const origin = req.headers.origin;

      if (url.pathname === '/mcp') {
        if (origin) throw new HttpError(403, 'Browser origins are not allowed on /mcp');
        return await handleMcp(req, res);
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');

      if (!origin || !allowedOrigins.has(origin)) throw new HttpError(403, 'Origin not allowed');
      const cors = {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-private-network': 'true',
        vary: 'Origin',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return void res.end();
      }
      await handleApi(req, res, url, cors);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
      if (status === 500) console.error('[review-notes] request failed:', e);
    }
  });

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, cors: Record<string, string>) {
    const parts = url.pathname.split('/').filter(Boolean); // api, ...
    const m = req.method ?? 'GET';
    const ok = (body: unknown, status = 200) => send(res, status, body, cors);

    if (parts[1] === 'health' && m === 'GET') return ok({ ok: true, version: SERVER_VERSION, dir: store.dir, noteCount: (await store.read()).notes.length });
    if (parts[1] === 'sync' && parts[2] === 'index' && m === 'GET') return ok(await store.index());

    if (parts[1] === 'notes' && parts[2]) {
      const id = decodeURIComponent(parts[2]);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, 'Bad note id');
      if (parts[3] === 'screenshot' && parts[4]) {
        const kind = parts[4];
        if (kind !== 'annotated' && kind !== 'clean') throw new HttpError(400, 'Bad screenshot kind');
        if (m === 'PUT') {
          await store.putShot(id, kind, await readBody(req, MAX_API_BODY));
          return ok({ ok: true });
        }
        if (m === 'GET') {
          const buf = await store.getShot(id, kind);
          if (!buf) throw new HttpError(404, 'No screenshot');
          return send(res, 200, buf, cors);
        }
      } else if (!parts[3]) {
        if (m === 'GET') {
          const n = await store.get(id);
          if (!n) throw new HttpError(404, 'No such note');
          return ok(n);
        }
        if (m === 'PUT') {
          const body = JSON.parse((await readBody(req, MAX_API_BODY)).toString('utf8'));
          if (body?.id !== id) throw new HttpError(400, 'Note id does not match URL');
          return ok(await store.upsert(body));
        }
        if (m === 'DELETE') {
          let updatedAt: string | undefined;
          try {
            updatedAt = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}').updatedAt;
          } catch {
            /* optional body */
          }
          return ok({ removed: await store.remove(id, updatedAt) });
        }
      }
    }
    throw new HttpError(404, 'Not found');
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
      return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' }, id: null }, { allow: 'POST' });
    }
    const raw = await readBody(req, MAX_MCP_BODY);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
    // Stateless: a fresh server + transport per request (state lives in the file store).
    const mcp = createMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return server;
}

export function listen(server: Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}
