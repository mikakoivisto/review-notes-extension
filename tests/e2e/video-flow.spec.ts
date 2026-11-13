import type { Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { test, expect, PAGES, readStoredScreenshot } from './fixtures';

async function seekVideo(page: Page, t: number) {
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

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const c = page.getByTestId('draw-canvas');
  const b = (await c.boundingBox())!;
  await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * ((from[0] + to[0]) / 2), b.y + b.height * ((from[1] + to[1]) / 2), { steps: 4 });
  await page.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps: 4 });
  await page.mouse.up();
}

test('video: draw, add note, see it in the panel with screenshot + timecode, click to seek back', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(`${PAGES}/video.html`);
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).readyState >= 2);
  await seekVideo(page, 3);

  const panel = await h.openPanel(page);
  await panel.getByTestId('btn-review').click();
  await expect(page.getByTestId('toolbar')).toBeVisible();
  await expect(panel.getByTestId('tab-adapter')).toHaveText('HTML5 video');

  await page.getByTestId('tool-box').click();
  await drag(page, [0.2, 0.2], [0.5, 0.5]);
  await page.getByTestId('tool-arrow').click();
  await drag(page, [0.7, 0.7], [0.55, 0.55]);

  await h.bringToFront(page);
  await page.getByTestId('btn-add-note').click();
  await page.getByTestId('note-text').fill('Logo is too small');
  await page.getByTestId('note-save').click();
  await expect(page.getByTestId('toast')).toContainText('Note saved');

  const card = panel.getByTestId('note-card').first();
  await expect(card).toBeVisible();
  await expect(card.getByTestId('note-time')).toContainText('00:03.00');
  await expect(card.getByTestId('note-text')).toHaveText('Logo is too small');
  const natural = await card.getByTestId('note-thumb').evaluate((img: HTMLImageElement) => new Promise<number>((r) => (img.complete && img.naturalWidth ? r(img.naturalWidth) : img.addEventListener('load', () => r(img.naturalWidth)))));
  expect(natural).toBeGreaterThan(100);

  const id = (await card.getAttribute('data-note-id'))!;
  for (const k of ['annotated', 'clean'] as const) { const b = await readStoredScreenshot(panel, id, k); if (b) writeFileSync(`/tmp/rn-${k}.png`, b); }
  await seekVideo(page, 6.5);
  await card.getByTestId('note-goto').click();
  await expect.poll(() => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime), { timeout: 8000 }).toBeCloseTo(3, 0);
});
