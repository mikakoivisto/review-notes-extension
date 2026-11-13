import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXTENSION_ID } from '../../src/shared/constants';

export const EXT_PATH = resolve('dist/extension');
export const PAGES = 'http://127.0.0.1:4173';

export interface Harness {
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  /** chrome tab id of a Playwright page */
  tabIdOf(page: Page): Promise<number>;
  /** opens the notes panel as a separate popup window (Playwright cannot drive the real side panel) */
  openPanel(forPage: Page): Promise<Page>;
  bringToFront(page: Page): Promise<void>;
}

export const test = base.extend<{ h: Harness }, { videoDir: string }>({
  videoDir: [async ({}, use) => use(process.env.PW_VIDEO_DIR || ''), { scope: 'worker' }],
  h: async ({ videoDir }, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'rn-pw-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', // full Chromium (new headless): the headless shell cannot load extensions
      headless: process.env.HEADED ? false : true,
      viewport: { width: 1100, height: 760 },
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--autoplay-policy=no-user-gesture-required'],
      ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1100, height: 760 } } } : {}),
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    const extensionId = new URL(sw.url()).host;
    expect(extensionId).toBe(EXTENSION_ID);
    const harness: Harness = {
      context,
      sw,
      extensionId,
      async tabIdOf(page) {
        const url = page.url();
        const id = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
        if (id === undefined) throw new Error(`no chrome tab for ${url}`);
        return id;
      },
      async openPanel(forPage) {
        const tabId = await harness.tabIdOf(forPage);
        const url = `chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`;
        const pagePromise = context.waitForEvent('page', { timeout: 10_000 });
        await sw.evaluate((u) => chrome.windows.create({ url: u, type: 'popup', width: 440, height: 760 }), url);
        const panel = await pagePromise;
        await panel.waitForLoadState('domcontentloaded');
        await panel.setViewportSize({ width: 440, height: 760 }).catch(() => {});
        return panel;
      },
      async bringToFront(page) {
        await page.bringToFront();
      },
    };
    await use(harness);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },
});
export { expect };

/** Reads a stored screenshot straight from the extension's IndexedDB (via any extension page). */
export async function readStoredScreenshot(extPage: Page, noteId: string, kind: 'annotated' | 'clean' = 'annotated'): Promise<Buffer | null> {
  const b64 = await extPage.evaluate(
    ({ noteId, kind }) =>
      new Promise<string | null>((resolve, reject) => {
        const open = indexedDB.open('review-notes');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const r = open.result.transaction('screenshots').objectStore('screenshots').get(`${noteId}/${kind}`);
          r.onerror = () => reject(r.error);
          r.onsuccess = async () => {
            if (!r.result) return resolve(null);
            const buf = new Uint8Array(await (r.result as Blob).arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            resolve(btoa(s));
          };
        };
      }),
    { noteId, kind },
  );
  return b64 ? Buffer.from(b64, 'base64') : null;
}

import type { Locator } from '@playwright/test';

export async function seekVideo(page: Page, t: number) {
  await page.evaluate(
    (time) =>
      new Promise<void>((resolve) => {
        const v = document.querySelector('video')!;
        v.pause();
        v.addEventListener('seeked', () => resolve(), { once: true });
        v.currentTime = time;
      }),
    t,
  );
}

export async function waitForVideo(page: Page) {
  await page.waitForFunction(() => ((document.querySelector('video') as HTMLVideoElement | null)?.readyState ?? 0) >= 2);
}

/** drag inside the draw canvas using fractions of its size */
export async function drag(page: Page, from: [number, number], to: [number, number]) {
  const b = (await page.getByTestId('draw-canvas').boundingBox())!;
  await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * ((from[0] + to[0]) / 2), b.y + b.height * ((from[1] + to[1]) / 2), { steps: 4 });
  await page.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps: 4 });
  await page.mouse.up();
}

export async function addNote(page: Page, text: string) {
  await page.getByTestId('btn-add-note').click();
  await page.getByTestId('note-text').fill(text);
  await page.getByTestId('note-save').click();
}

export async function thumbWidth(card: Locator): Promise<number> {
  return card.getByTestId('note-thumb').evaluate((img: HTMLImageElement) => new Promise<number>((r) => (img.complete && img.naturalWidth ? r(img.naturalWidth) : img.addEventListener('load', () => r(img.naturalWidth)))));
}

export async function startReview(panel: Page, page: Page) {
  await panel.getByTestId('btn-review').click();
  await page.getByTestId('toolbar').waitFor();
}
