import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NOTE_STATUSES, NOTE_TYPES, type Note } from '../shared/schema';
import { formatTime } from '../shared/time';
import type { NoteStore } from './store';

export const SERVER_NAME = 'review-notes';
export const SERVER_VERSION = '0.1.0';

const clip = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function noteLine(n: Note): string {
  const when = n.time ? ` ${formatTime(n.time)}` : '';
  return `#${n.seq} [${n.status}] ${n.type}${when} — ${clip(n.text.replace(/\s+/g, ' ')) || '(no text)'} — ${n.url} — id ${n.id}${n.screenshot ? ' — has screenshot' : ''}`;
}

function describe(n: Note, store: NoteStore): string {
  const lines = [
    `#${n.seq} (${n.id}) — ${n.status} — ${n.type}`,
    `Page: ${n.pageTitle || '(untitled)'} <${n.url}>`,
    `Adapter: ${n.adapter}${n.media?.compositionId ? `, composition "${n.media.compositionId}"` : ''}${n.media?.videoId ? `, video ${n.media.videoId}` : ''}`,
  ];
  if (n.time) lines.push(`Time: ${formatTime(n.time)}${n.time.fps ? ` @ ${n.time.fps}fps` : ''}`);
  lines.push(`Note: ${n.text || '(no text)'}`);
  if (n.reply) lines.push(`Reply: ${n.reply}`);
  if (n.annotation?.shapes.length) lines.push(`Annotation: ${n.annotation.shapes.map((s) => s.t).join(', ')} (normalised 0..1 on the ${n.annotation.anchor} rect)`);
  if (n.screenshot) {
    lines.push(`Screenshot (annotated): ${store.shotFile(n.id, 'annotated')}`);
    if (n.screenshot.clean) lines.push(`Screenshot (clean): ${store.shotFile(n.id, 'clean')}`);
    if (n.screenshot.suspectedBlack) lines.push('WARNING: the screenshot looks black (DRM-protected video or empty frame).');
  }
  return lines.join('\n');
}

const text = (t: string, structured?: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: t }], ...(structured ? { structuredContent: structured } : {}) });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** Builds an MCP server exposing the review-notes tools over any transport. Never writes to stdout. */
export function createMcpServer(store: NoteStore): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const ref = z.union([z.string(), z.number()]).describe('Note id, or its sequence number like "12" / "#12"');

  server.registerTool(
    'list_notes',
    {
      title: 'List review notes',
      description: 'List review notes left by the reviewer on videos/web pages. Defaults to open notes. Returns one line per note; use get_note / get_screenshot for details.',
      inputSchema: {
        status: z.enum([...NOTE_STATUSES, 'all']).optional().describe('Filter by status (default: open)'),
        url: z.string().optional().describe('Substring of the page URL'),
        type: z.enum(NOTE_TYPES).optional(),
        adapter: z.string().optional().describe('remotion | youtube | html5-video | generic | none'),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async (a) => {
      const notes = await store.list({ status: a.status ?? 'open', url: a.url, type: a.type, adapter: a.adapter, limit: a.limit });
      if (!notes.length) return text(`No ${a.status && a.status !== 'all' ? a.status : a.status === 'all' ? '' : 'open '}notes.`.replace('  ', ' '), { notes: [] });
      return text(`${notes.length} note(s) in ${store.dir}:\n` + notes.map(noteLine).join('\n'), { notes: notes.map((n) => ({ id: n.id, seq: n.seq, status: n.status, type: n.type, url: n.url, time: n.time, text: n.text, adapter: n.adapter, hasScreenshot: !!n.screenshot })) });
    },
  );

  server.registerTool(
    'get_note',
    {
      title: 'Get one review note',
      description: 'Full details of a note: text, timecode/frame, page, annotation summary, reply and screenshot file paths.',
      inputSchema: { id: ref },
    },
    async ({ id }) => {
      const n = await store.get(id);
      if (!n) return fail(`No note matches "${id}".`);
      return text(describe(n, store), { note: n });
    },
  );

  server.registerTool(
    'get_screenshot',
    {
      title: 'Get a note screenshot',
      description: 'The screenshot of a note as an image (annotated = with the reviewer’s drawing, clean = without). Also returns the file path.',
      inputSchema: { id: ref, kind: z.enum(['annotated', 'clean']).optional() },
    },
    async ({ id, kind }) => {
      const n = await store.get(id);
      if (!n) return fail(`No note matches "${id}".`);
      const k = kind ?? 'annotated';
      const buf = await store.getShot(n.id, k);
      if (!buf) return fail(`Note #${n.seq} has no ${k} screenshot.`);
      return {
        content: [
          { type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' },
          { type: 'text' as const, text: `Screenshot (${k}) of note #${n.seq}: ${store.shotFile(n.id, k)}${n.screenshot?.suspectedBlack ? '\nWARNING: looks black (DRM-protected video or empty frame).' : ''}` },
        ],
      };
    },
  );

  server.registerTool(
    'update_note_status',
    {
      title: 'Update a note status',
      description: 'Set a note’s status (open | in_progress | fixed | wontfix) with an optional short reply the reviewer will see.',
      inputSchema: { id: ref, status: z.enum(NOTE_STATUSES), reply: z.string().max(2000).optional() },
    },
    async ({ id, status, reply }) => {
      try {
        const n = await store.setStatus(id, status, reply);
        return text(`#${n.seq} → ${n.status}${n.reply ? ` · ${n.reply}` : ''}`, { note: n });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'mark_fixed',
    {
      title: 'Mark a note fixed',
      description: 'Shortcut for update_note_status(status = "fixed") with an optional one-sentence reply describing the fix.',
      inputSchema: { id: ref, reply: z.string().max(2000).optional() },
    },
    async ({ id, reply }) => {
      try {
        const n = await store.setStatus(id, 'fixed', reply);
        return text(`#${n.seq} → fixed${n.reply ? ` · ${n.reply}` : ''}`, { note: n });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'claim_notes',
    {
      title: 'Claim notes',
      description: 'Mark open notes as in_progress (so the reviewer sees an agent took them) and return them. Without ids, claims every open note.',
      inputSchema: { ids: z.array(ref).optional() },
    },
    async ({ ids }) => {
      const notes = await store.claim(ids);
      if (!notes.length) return text('No open notes to claim.', { notes: [] });
      return text(`Claimed ${notes.length} note(s):\n` + notes.map(noteLine).join('\n'), { notes: notes.map((n) => ({ id: n.id, seq: n.seq, status: n.status })) });
    },
  );

  return server;
}
