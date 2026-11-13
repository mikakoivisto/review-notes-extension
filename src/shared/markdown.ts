import type { Note } from './schema';
import { formatTime } from './time';

function sortKey(n: Note): [number, string] {
  return [n.time ? n.time.seconds : Number.POSITIVE_INFINITY, n.createdAt];
}

export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.url !== b.url) return a.url < b.url ? -1 : 1;
    const [ta, ca] = sortKey(a);
    const [tb, cb] = sortKey(b);
    return ta !== tb ? (ta < tb ? -1 : 1) : ca < cb ? -1 : ca > cb ? 1 : 0;
  });
}

/** Human/agent readable rendering of a notes list. Generated, never parsed back. */
export function notesToMarkdown(notes: Note[], opts: { title?: string } = {}): string {
  const lines: string[] = [`# ${opts.title ?? 'Review notes'}`, ''];
  if (notes.length === 0) lines.push('_No notes._', '');
  let currentUrl = '';
  for (const n of sortNotes(notes)) {
    if (n.url !== currentUrl) {
      currentUrl = n.url;
      lines.push(`## ${n.pageTitle || n.url}`, '', `<${n.url}>`, '');
    }
    const when = n.time ? ` · ${formatTime(n.time)}` : '';
    lines.push(`### #${n.seq} · ${n.type} · ${n.status}${when}`, '');
    lines.push(`- id: \`${n.id}\``);
    lines.push(`- adapter: ${n.adapter}${n.media?.compositionId ? ` (composition \`${n.media.compositionId}\`)` : ''}`);
    if (n.annotation && n.annotation.shapes.length) {
      const kinds = [...new Set(n.annotation.shapes.map((s) => s.t))].join(', ');
      lines.push(`- annotation: ${n.annotation.shapes.length} shape(s) (${kinds}) on ${n.annotation.anchor}`);
    }
    lines.push('');
    if (n.text.trim()) lines.push(n.text.trim().split('\n').map((l) => `> ${l}`).join('\n'), '');
    if (n.reply) lines.push(`**Reply:** ${n.reply}`, '');
    if (n.screenshot) {
      lines.push(`![note ${n.seq}](${n.screenshot.annotated})`);
      if (n.screenshot.suspectedBlack) lines.push('', '_Screenshot looks black (DRM-protected or empty frame)._');
      lines.push('');
    }
  }
  return lines.join('\n');
}
