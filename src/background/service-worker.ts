/**
 * MV3 service worker. STATELESS: everything lives in IndexedDB / chrome.storage; the worker can be killed
 * at any moment. (The only module-level variable, `lastCaptureAt`, is a best-effort rate-limit hint.)
 */
import { NotesDb } from '../shared/db';
import { newId } from '../shared/ids';
import { isSuspectedBlack } from '../shared/blackframe';
import { NOTES_CHANGED, type CaptureRequest, type CaptureResult, type ContentMessage, type SwMessage, type SwReply, type TabState } from '../shared/messages';
import { screenshotPath, type Note, type ScreenshotKind, type ScreenshotRef } from '../shared/schema';
import { getSettings, getSyncStatus, syncOnce } from './sync';

const db = new NotesDb();

class SwError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

// ---------- helpers --------------------------------------------------------------------------------------------
function broadcast() {
  chrome.runtime.sendMessage({ type: NOTES_CHANGED }).catch(() => {});
}

function isWebUrl(url?: string): boolean {
  return !!url && /^(https?|file):/.test(url);
}

async function blobFromDataUrl(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

let lastCaptureAt = 0;
let captureChain: Promise<unknown> = Promise.resolve();

/** captureVisibleTab is rate limited (~2/s): serialise and space captures. */
function captureVisible(windowId: number): Promise<string> {
  const run = async () => {
    const wait = lastCaptureAt + 650 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } finally {
      lastCaptureAt = Date.now();
    }
  };
  const p = captureChain.then(run, run);
  captureChain = p.catch(() => {});
  return p;
}

async function cropAndEncode(dataUrl: string, req: CaptureRequest): Promise<CaptureResult> {
  const bmp = await createImageBitmap(await blobFromDataUrl(dataUrl));
  const scale = bmp.width / Math.max(1, req.innerWidth);
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  let crop: 'media' | 'viewport' = 'viewport';
  const r = req.rect;
  if (r && r.width > 8 && r.height > 8) {
    sx = Math.max(0, Math.min(bmp.width - 1, Math.round(r.x * scale)));
    sy = Math.max(0, Math.min(bmp.height - 1, Math.round(r.y * scale)));
    sw = Math.max(1, Math.min(bmp.width - sx, Math.round(r.width * scale)));
    sh = Math.max(1, Math.min(bmp.height - sy, Math.round(r.height * scale)));
    crop = 'media';
  }
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d')!.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  let suspectedBlack = false;
  if (crop === 'media') {
    const small = new OffscreenCanvas(32, 32);
    const sctx = small.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(canvas, 0, 0, 32, 32);
    suspectedBlack = isSuspectedBlack(sctx.getImageData(0, 0, 32, 32).data);
  }
  const out = await canvas.convertToBlob({ type: 'image/png' });
  return { dataUrl: await blobToDataUrl(out), width: sw, height: sh, crop, suspectedBlack };
}

async function sendToTab<T>(tabId: number, msg: ContentMessage): Promise<T> {
  const reply = (await chrome.tabs.sendMessage(tabId, msg)) as SwReply<T> | undefined;
  if (!reply) throw new SwError('The page did not answer', 'NO_REPLY');
  if (!reply.ok) throw new SwError(reply.error ?? 'Page error');
  return reply.data as T;
}

/** Injects the content script on demand (no static content scripts: nothing runs until review is started). */
async function ensureInjected(tabId: number): Promise<void> {
  try {
    await sendToTab(tabId, { type: 'tab:ping' });
    return;
  } catch {
    /* not injected yet */
  }
  const tab = await chrome.tabs.get(tabId);
  if (!isWebUrl(tab.url)) throw new SwError(`This page (${tab.url?.split(':')[0] ?? 'unknown'}:) cannot be annotated. Use "Screenshot note" instead.`, 'CANNOT_INJECT');
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    throw new SwError(`Cannot inject into this page (${e instanceof Error ? e.message : e}). Use "Screenshot note" instead.`, 'CANNOT_INJECT');
  }
}

async function tabState(tabId: number): Promise<TabState> {
  try {
    await ensureInjectedIfActive(tabId);
    return await sendToTab<TabState>(tabId, { type: 'tab:getState' });
  } catch {
    const tab = await chrome.tabs.get(tabId);
    return {
      active: false,
      adapter: 'none',
      adapterName: isWebUrl(tab.url) ? 'Not started' : 'Unsupported page',
      title: tab.title ?? '',
      url: tab.url ?? '',
      time: null,
      paused: null,
      canSeek: false,
      media: null,
    };
  }
}

/** Only talk to tabs that already have the content script; getState must not inject by itself. */
async function ensureInjectedIfActive(tabId: number) {
  await sendToTab(tabId, { type: 'tab:ping' });
}

function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
  } catch {
    return a === b;
  }
}

async function waitForComplete(tabId: number, timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---------- handlers -------------------------------------------------------------------------------------------
async function createNote(msg: Extract<SwMessage, { type: 'note:create' }>): Promise<Note> {
  const { note, screenshots } = msg.payload;
  const id = newId();
  const blobs: Partial<Record<ScreenshotKind, Blob>> = {};
  let screenshot: ScreenshotRef | null = null;
  if (screenshots.annotated) {
    blobs.annotated = await blobFromDataUrl(screenshots.annotated.dataUrl);
    screenshot = {
      annotated: screenshotPath(id, 'annotated'),
      width: screenshots.annotated.width,
      height: screenshots.annotated.height,
      crop: screenshots.annotated.crop,
      suspectedBlack: screenshots.annotated.suspectedBlack,
    };
    if (screenshots.clean) {
      blobs.clean = await blobFromDataUrl(screenshots.clean.dataUrl);
      screenshot.clean = screenshotPath(id, 'clean');
    }
  }
  const now = new Date().toISOString();
  const full = await db.createNote({ ...note, id, status: note.status ?? 'open', screenshot, createdAt: now, updatedAt: now }, blobs);
  broadcast();
  void syncSoon();
  return full;
}

async function screenshotOnlyNote(tabId: number, text = '', type: Note['type'] = 'general'): Promise<Note> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new SwError('The tab must be visible to take a screenshot', 'TAB_NOT_VISIBLE');
  const dataUrl = await captureVisible(tab.windowId);
  const shot = await cropAndEncode(dataUrl, { rect: null, innerWidth: tab.width ?? 1 });
  return createNote({
    type: 'note:create',
    payload: {
      note: {
        url: tab.url ?? '',
        pageTitle: tab.title ?? '',
        adapter: 'none',
        media: null,
        time: null,
        type,
        text,
        annotation: null,
        context: { scrollX: 0, scrollY: 0, viewportWidth: tab.width ?? 0, viewportHeight: tab.height ?? 0, devicePixelRatio: 1 },
      },
      screenshots: { annotated: shot },
    },
  });
}

async function gotoNote(id: string, tabId: number) {
  const note = await db.getNote(id);
  if (!note) throw new SwError('Note not found', 'NOT_FOUND');
  let tab = await chrome.tabs.get(tabId);
  if (!sameDocument(tab.url ?? '', note.url)) {
    await chrome.tabs.update(tabId, { url: note.url });
    await new Promise((r) => setTimeout(r, 300));
    await waitForComplete(tabId);
    tab = await chrome.tabs.get(tabId);
  }
  await ensureInjected(tabId);
  return sendToTab(tabId, { type: 'tab:goto', note: { time: note.time, annotation: note.annotation, context: note.context, adapter: note.adapter } });
}

async function importNotes(msg: Extract<SwMessage, { type: 'import:notes' }>) {
  const counts = { added: 0, updated: 0, kept: 0, tombstoned: 0 };
  for (const n of msg.notes) {
    const b = msg.blobs[n.id] ?? {};
    const blobs: Partial<Record<ScreenshotKind, Blob>> = {};
    if (b.annotated) blobs.annotated = new Blob([b.annotated], { type: 'image/png' });
    if (b.clean) blobs.clean = new Blob([b.clean], { type: 'image/png' });
    counts[await db.mergeNote(n, blobs)]++;
  }
  broadcast();
  void syncSoon();
  return counts;
}

async function syncSoon() {
  const s = await getSettings();
  if (s.syncEnabled) void syncOnce(db).catch(() => {});
}

async function lastWebTab(): Promise<number | null> {
  const s = await chrome.storage.session.get('lastWebTab');
  return (s.lastWebTab as number | undefined) ?? null;
}

async function handle(msg: SwMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'capture:screenshot': {
      const tab = sender.tab;
      if (!tab?.id) throw new SwError('Screenshots must be requested from a page', 'NO_TAB');
      const fresh = await chrome.tabs.get(tab.id);
      if (!fresh.active) throw new SwError('The tab is not visible', 'TAB_NOT_VISIBLE');
      return cropAndEncode(await captureVisible(fresh.windowId), msg.req);
    }
    case 'note:create':
      return createNote(msg);
    case 'note:screenshotOnly':
      return screenshotOnlyNote(msg.tabId, msg.text, msg.type_);
    case 'note:update': {
      const n = await db.updateNote(msg.id, msg.patch);
      if (!n) throw new SwError('Note not found', 'NOT_FOUND');
      broadcast();
      void syncSoon();
      return n;
    }
    case 'note:delete': {
      const ok = await db.deleteNote(msg.id);
      broadcast();
      void syncSoon();
      return ok;
    }
    case 'note:goto':
      return gotoNote(msg.id, msg.tabId);
    case 'review:start':
      await ensureInjected(msg.tabId);
      return sendToTab(msg.tabId, { type: 'review:start' });
    case 'review:stop':
      await ensureInjected(msg.tabId);
      return sendToTab(msg.tabId, { type: 'review:stop' });
    case 'review:toggle':
      return toggleReview(msg.tabId);
    case 'tab:getState':
      return tabState(msg.tabId);
    case 'bridge:ensure': {
      const tabId = sender.tab?.id;
      if (!tabId) return false;
      await chrome.scripting.executeScript({ target: { tabId }, files: ['bridge.js'], world: 'MAIN' });
      return true;
    }
    case 'import:notes':
      return importNotes(msg);
    case 'sync:now':
      return syncOnce(db);
    case 'sync:status':
      return getSyncStatus();
    case 'tabs:lastWeb':
      return lastWebTab();
    default:
      throw new SwError('Unknown message');
  }
}

async function toggleReview(tabId: number) {
  await ensureInjected(tabId);
  return sendToTab<TabState>(tabId, { type: 'review:toggle' });
}

chrome.runtime.onMessage.addListener((msg: SwMessage | { type: string }, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.type === NOTES_CHANGED) return false;
  handle(msg as SwMessage, sender).then(
    (data) => sendResponse({ ok: true, data } satisfies SwReply),
    (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e), code: e instanceof SwError ? e.code : undefined } satisfies SwReply),
  );
  return true;
});

// ---------- browser integration --------------------------------------------------------------------------------
async function rememberTab(tabId: number) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isWebUrl(tab.url)) await chrome.storage.session.set({ lastWebTab: tabId });
  } catch {
    /* tab gone */
  }
}
chrome.tabs.onActivated.addListener((i) => void rememberTab(i.tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') void rememberTab(tabId);
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  // sidePanel.open must be called synchronously inside the user gesture
  void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  void toggleReview(tab.id).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-review') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) void toggleReview(tab.id).catch(() => {});
});

async function setupAlarms() {
  const s = await getSettings();
  if (s.syncEnabled) await chrome.alarms.create('rn-sync', { periodInMinutes: 1 });
  else await chrome.alarms.clear('rn-sync');
}
chrome.runtime.onInstalled.addListener(() => void setupAlarms());
chrome.runtime.onStartup.addListener(() => void setupAlarms());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    void setupAlarms();
    void syncSoon();
  }
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'rn-sync') void syncSoon();
});
