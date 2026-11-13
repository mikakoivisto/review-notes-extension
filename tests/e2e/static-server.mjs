// Tiny static server for e2e pages. Routes under tests/fixtures/pages/*.html; /media/* serves tests/fixtures.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures');
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.webm': 'video/webm', '.png': 'image/png', '.js': 'text/javascript' };

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = rel.startsWith('/media/') ? join(root, rel.slice('/media/'.length)) : join(root, 'pages', rel === '/' ? 'video.html' : rel);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  const headers = { 'content-type': types[extname(file)] || 'application/octet-stream', 'accept-ranges': 'bytes' };
  if (rel === '/csp.html') headers['content-security-policy'] = "default-src 'none'; media-src 'self'; img-src 'self' data:; style-src 'none'; script-src 'none'";
  const size = statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'content-length': size });
    createReadStream(file).pipe(res);
  }
}).listen(port, '127.0.0.1', () => console.log(`static server on http://127.0.0.1:${port}`));
