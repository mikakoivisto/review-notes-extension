import { NotesDb } from '../shared/db';
import { exportFromDb, parseImport } from '../shared/export';
import { NOTES_CHANGED, type TabState } from '../shared/messages';
import { callSw } from '../shared/rpc';
import { NOTE_STATUSES, NOTE_TYPES } from '../shared/enums';
import type { Note, NoteStatus } from '../shared/schema';
import { formatTime } from '../shared/time';
import type { SyncStatus } from '../background/sync';

const db = new NotesDb();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The panel never assumes "the active tab": it may itself be open as a tab/window (tests, popup window). */
const pinnedTab = Number(new URLSearchParams(location.search).get('tabId')) || null;

let notes: Note[] = [];
let filter: NoteStatus | 'all' = 'all';
let tabId: number | null = pinnedTab;
let tabUrl = '';
let editing: string | null = null;
let confirmDelete: string | null = null;
const thumbUrls = new Map<string, string>();

const STATUS_LABEL: Record<NoteStatus | 'all', string> = { all: 'All', open: 'Open', in_progress: 'In progress', fixed: 'Fixed', wontfix: "Won't fix" };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined) e.append(k);
  return e;
}

function showError(msg: string) {
  const e = $('error');
  e.textContent = msg;
  e.hidden = !msg;
}
function showMsg(msg: string) {
  $('msg').textContent = msg;
}
async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    showError('');
    return await fn();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

async function resolveTab(): Promise<number | null> {
  if (pinnedTab) return pinnedTab;
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (t?.id && /^(https?|file):/.test(t.url ?? '')) return t.id;
  return (await callSw<number | null>({ type: 'tabs:lastWeb' })) ?? t?.id ?? null;
}

// ---------- tab info -------------------------------------------------------------------------------------------
let lastState: TabState | null = null;
async function pollTab() {
  tabId = await resolveTab();
  if (!tabId) return;
  try {
    const s = await callSw<TabState>({ type: 'tab:getState', tabId });
    lastState = s;
    tabUrl = s.url;
    document.querySelector('[data-testid=tab-adapter]')!.textContent = s.active ? s.adapterName : `${s.adapterName}`;
    document.querySelector('[data-testid=tab-time]')!.textContent = s.time ? formatTime(s.time) : 'no timecode';
    document.querySelector('[data-testid=tab-title]')!.textContent = s.title;
    $('btn-review').textContent = s.active ? 'Stop review' : 'Start review';
    if (s.overlayFailed) showError(`Overlay could not start (${s.overlayFailed}). Use "Screenshot note".`);
    renderFilters();
  } catch {
    /* tab closed */
  }
}

// ---------- notes list -----------------------------------------------------------------------------------------
async function load() {
  notes = (await db.listNotes()).reverse(); // newest first
  render();
}

function visibleNotes(): Note[] {
  const pageOnly = ($('scope-page') as HTMLInputElement).checked;
  return notes.filter((n) => (filter === 'all' || n.status === filter) && (!pageOnly || !tabUrl || sameDoc(n.url, tabUrl)));
}
function sameDoc(a: string, b: string) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
  } catch {
    return a === b;
  }
}

function renderFilters() {
  const nav = $('filters');
  nav.replaceChildren(
    ...(['all', ...NOTE_STATUSES] as const).map((s) => {
      const count = s === 'all' ? notes.length : notes.filter((n) => n.status === s).length;
      const b = h('button', { class: 'chip' + (filter === s ? ' active' : ''), 'data-testid': `filter-${s}`, type: 'button' }, `${STATUS_LABEL[s]} ${count}`);
      b.addEventListener('click', () => {
        filter = s;
        render();
      });
      return b;
    }),
  );
}

function render() {
  renderFilters();
  const list = $('list');
  const items = visibleNotes();
  if (!items.length) {
    list.replaceChildren(h('div', { class: 'empty', 'data-testid': 'empty' }, notes.length ? 'No notes match the filter.' : 'No notes yet. Start a review, draw, and press “Add note”.'));
    return;
  }
  list.replaceChildren(...items.map(card));
}

function card(n: Note): HTMLElement {
  const c = h('div', { class: 'card', 'data-testid': 'note-card', 'data-note-id': n.id, 'data-seq': String(n.seq) });
  const head = h(
    'div',
    { class: 'head', 'data-testid': 'note-head', title: 'Go to this moment' },
    h('span', { class: 'seq' }, `#${n.seq}`),
    n.time ? h('span', { class: 'time', 'data-testid': 'note-time' }, formatTime(n.time)) : h('span', { class: 'muted', 'data-testid': 'note-time' }, 'page'),
    h('span', { class: 'badge' }, n.type),
    h('span', { class: `badge ${n.status}`, 'data-testid': 'note-status-badge' }, STATUS_LABEL[n.status]),
  );
  head.addEventListener('click', () => void goto(n));
  c.append(head);

  if (n.screenshot) {
    const img = h('img', { alt: `Screenshot of note ${n.seq}`, 'data-testid': 'note-thumb' });
    img.addEventListener('click', () => void openShot(n));
    void thumb(n).then((u) => u && (img.src = u));
    c.append(img);
    if (n.screenshot.suspectedBlack) c.append(h('div', { class: 'warn', 'data-testid': 'black-warning' }, '⚠ Screenshot looks black (DRM-protected or empty frame).'));
  }

  if (editing === n.id) {
    const ta = h('textarea', { 'data-testid': 'edit-text' });
    ta.value = n.text;
    const type = h('select', { 'data-testid': 'edit-type' });
    for (const t of NOTE_TYPES) type.append(h('option', { value: t }, t));
    type.value = n.type;
    const save = h('button', { class: 'primary', 'data-testid': 'edit-save', type: 'button' }, 'Save');
    save.addEventListener('click', () =>
      void run(async () => {
        await callSw({ type: 'note:update', id: n.id, patch: { text: ta.value, type: type.value as Note['type'] } });
        editing = null;
      }),
    );
    const cancel = h('button', { type: 'button', 'data-testid': 'edit-cancel' }, 'Cancel');
    cancel.addEventListener('click', () => {
      editing = null;
      render();
    });
    c.append(h('div', { class: 'body' }, ta), h('div', { class: 'actions' }, type, save, cancel));
    return c;
  }

  if (n.text) c.append(h('div', { class: 'body', 'data-testid': 'note-text' }, n.text));
  if (n.reply) c.append(h('div', { class: 'reply', 'data-testid': 'note-reply' }, `↩ ${n.reply}`));

  const status = h('select', { 'data-testid': 'note-status', title: 'Status' });
  for (const s of NOTE_STATUSES) status.append(h('option', { value: s }, STATUS_LABEL[s]));
  status.value = n.status;
  status.addEventListener('change', () => void run(() => callSw({ type: 'note:update', id: n.id, patch: { status: status.value as NoteStatus } })));
  const edit = h('button', { type: 'button', 'data-testid': 'note-edit' }, 'Edit');
  edit.addEventListener('click', () => {
    editing = n.id;
    render();
  });
  const del = h('button', { type: 'button', class: 'danger', 'data-testid': 'note-delete' }, confirmDelete === n.id ? 'Confirm delete?' : 'Delete');
  del.addEventListener('click', () => {
    if (confirmDelete !== n.id) {
      confirmDelete = n.id;
      render();
      setTimeout(() => {
        if (confirmDelete === n.id) {
          confirmDelete = null;
          render();
        }
      }, 4000);
      return;
    }
    confirmDelete = null;
    void run(() => callSw({ type: 'note:delete', id: n.id }));
  });
  const go = h('button', { type: 'button', 'data-testid': 'note-goto' }, '⏵ Go to');
  go.addEventListener('click', () => void goto(n));
  c.append(h('div', { class: 'actions' }, go, status, edit, del));
  return c;
}

async function thumb(n: Note): Promise<string | undefined> {
  const key = `${n.id}:${n.updatedAt.length}`;
  const cached = thumbUrls.get(n.id);
  if (cached && key) return cached;
  const blob = await db.getScreenshot(n.id, 'annotated');
  if (!blob) return undefined;
  const url = URL.createObjectURL(blob);
  thumbUrls.set(n.id, url);
  return url;
}

async function openShot(n: Note) {
  const u = await thumb(n);
  if (u) void chrome.tabs.create({ url: u });
}

async function goto(n: Note) {
  const t = tabId ?? (await resolveTab());
  if (!t) return showError('No page to seek. Open the page and start a review first.');
  showMsg('');
  const res = await run(() => callSw<{ seeked: boolean; hasTime: boolean }>({ type: 'note:goto', id: n.id, tabId: t }));
  if (res) showMsg(res.hasTime ? (res.seeked ? `Jumped to ${formatTime(n.time)}` : 'Page opened, but this player could not be seeked') : 'Restored scroll position');
}

// ---------- actions --------------------------------------------------------------------------------------------
$('btn-review').addEventListener('click', () =>
  void run(async () => {
    const t = tabId ?? (await resolveTab());
    if (!t) throw new Error('No page found. Focus a web page first.');
    await callSw({ type: 'review:toggle', tabId: t });
    await pollTab();
  }),
);
$('btn-shot').addEventListener('click', () =>
  void run(async () => {
    const t = tabId ?? (await resolveTab());
    if (!t) throw new Error('No page found. Focus a web page first.');
    await callSw({ type: 'note:screenshotOnly', tabId: t });
    showMsg('Screenshot note added');
  }),
);
$('btn-options').addEventListener('click', () => void chrome.runtime.openOptionsPage());
$('btn-window').addEventListener('click', async () => {
  const t = tabId ?? (await resolveTab());
  await chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html') + (t ? `?tabId=${t}` : ''), type: 'popup', width: 440, height: 820 });
});
$('scope-page').addEventListener('change', render);
$('btn-export').addEventListener('click', () =>
  void run(async () => {
    const bytes = await exportFromDb(db);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
    const a = h('a', { href: url, download: `review-notes-${new Date().toISOString().slice(0, 10)}.zip`, 'data-testid': 'export-link' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showMsg(`Exported ${notes.length} note(s)`);
  }),
);
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', (ev) =>
  void run(async () => {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    const parsed = await parseImport(new Uint8Array(await f.arrayBuffer()));
    const counts = await callSw<{ added: number; updated: number; kept: number }>({ type: 'import:notes', notes: parsed.notes, blobs: parsed.blobs });
    showMsg(`Imported: ${counts.added} added, ${counts.updated} updated, ${counts.kept} unchanged${parsed.skipped ? `, ${parsed.skipped} invalid skipped` : ''}`);
    input.value = '';
  }),
);

async function pollSync() {
  const st = await callSw<SyncStatus>({ type: 'sync:status' }).catch(() => ({ state: 'off' }) as SyncStatus);
  $('sync').textContent =
    st.state === 'ok' ? `Companion: synced (${st.remoteNotes} notes · ${st.dir})` : st.state === 'error' ? `Companion: offline — ${st.error}` : 'Companion sync: off (local only)';
}

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === NOTES_CHANGED) {
    void load();
    void pollSync();
  }
});
chrome.tabs.onActivated.addListener(() => void pollTab());

void (async () => {
  await load();
  await pollTab();
  await pollSync();
  setInterval(() => void pollTab(), 500);
  setInterval(() => void pollSync(), 5000);
  // pull agent changes when the panel regains focus
  window.addEventListener('focus', () => void callSw({ type: 'sync:now' }).then(() => pollSync()).catch(() => {}));
})();
