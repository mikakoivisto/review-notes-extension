import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_PORT } from '../shared/constants';
import { createHttpServer, listen } from './http';
import { createMcpServer } from './mcp';
import { NoteStore, defaultDir } from './store';

const HELP = `review-notes-companion — local companion for the Review Notes browser extension

Usage:
  review-notes-companion serve [--dir DIR] [--port ${DEFAULT_PORT}] [--allow-origin ORIGIN]
      HTTP on 127.0.0.1: extension sync API (/api/*) and MCP streamable HTTP (/mcp)
  review-notes-companion mcp [--dir DIR]
      MCP over stdio (for Claude Code, T3 Code, ...). Logs go to stderr.
  review-notes-companion print-config [--dir DIR] [--port ${DEFAULT_PORT}]
      Print ready-to-paste MCP client configuration

--dir defaults to $REVIEW_NOTES_DIR or ~/.review-notes. Use <project>/.review-notes to keep notes inside a project.
`;

function parse(argv: string[]) {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const flags: Record<string, string[]> = {};
  for (let i = cmd === argv[0] ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      (flags[k] ??= []).push(v ?? argv[++i] ?? '');
    }
  }
  return { cmd, flags };
}

async function main() {
  const { cmd, flags } = parse(process.argv.slice(2));
  const dir = flags.dir?.[0] ? resolve(flags.dir[0]) : defaultDir();
  const port = Number(flags.port?.[0] ?? process.env.REVIEW_NOTES_PORT ?? DEFAULT_PORT);
  const store = new NoteStore(dir);

  if (cmd === 'serve') {
    const server = createHttpServer({ store, allowedOrigins: flags['allow-origin'] });
    const actual = await listen(server, port);
    console.log(`review-notes companion listening on http://127.0.0.1:${actual}`);
    console.log(`  notes dir : ${store.dir}`);
    console.log(`  MCP (HTTP): http://127.0.0.1:${actual}/mcp`);
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } else if (cmd === 'mcp') {
    // stdout is the protocol channel: everything else goes to stderr.
    const server = createMcpServer(store);
    await server.connect(new StdioServerTransport());
    console.error(`[review-notes] MCP stdio server ready (dir: ${store.dir})`);
  } else if (cmd === 'print-config') {
    const self = fileURLToPath(import.meta.url);
    console.log(`# Claude Code (stdio)
claude mcp add review-notes -- node ${self} mcp --dir ${store.dir}

# Claude Code (HTTP; needs \`serve\` running)
claude mcp add --transport http review-notes http://127.0.0.1:${port}/mcp

# .mcp.json / generic stdio client
${JSON.stringify({ mcpServers: { 'review-notes': { command: 'node', args: [self, 'mcp', '--dir', store.dir] } } }, null, 2)}`);
  } else {
    console.log(HELP);
    process.exit(cmd === 'help' ? 0 : 1);
  }
}

main().catch((e) => {
  console.error('[review-notes] fatal:', e);
  process.exit(1);
});
