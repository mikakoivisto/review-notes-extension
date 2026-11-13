import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const STUDIO = 'http://localhost:3123/Hello';
const frameText = (p: Page) => p.locator('#frame-counter').textContent();

test('remotion studio: reads frame/fps, notes carry the frame, click seeks back via the bridge', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(STUDIO);
  await expect(page.locator('button.__remotion_input_dragger[aria-label="Frame Rate"]')).toHaveText('30fps');
  const panel = await h.openPanel(page);
  await panel.getByTestId('btn-review').click();
  await expect(page.getByTestId('toolbar')).toBeVisible();
  await expect(panel.getByTestId('tab-adapter')).toHaveText('Remotion Studio');

  // seek the Studio to frame 42 (what a user would do by scrubbing), the adapter must read it
  await page.evaluate(() => (window as any).remotion_setFrame(42, 'Hello'));
  await expect(panel.getByTestId('tab-time')).toContainText('frame 42');

  await page.getByTestId('tool-box').click();
  const b = (await page.getByTestId('draw-canvas').boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await page.getByTestId('btn-add-note').click();
  await page.getByTestId('note-text').fill('Title overlaps the frame counter');
  await page.getByTestId('note-save').click();
  await expect(page.getByTestId('toast')).toContainText('Note saved');

  const card = panel.getByTestId('note-card').first();
  await expect(card.getByTestId('note-time')).toContainText('frame 42');
  await expect(card.getByTestId('note-time')).toContainText('00:01.40'); // 42 / 30 fps

  // move elsewhere, then click the note: the Studio must return to frame 42
  await page.evaluate(() => (window as any).remotion_setFrame(120, 'Hello'));
  await expect.poll(() => frameText(page)).toBe('frame 120');
  await card.getByTestId('note-goto').click();
  await expect.poll(() => frameText(page), { timeout: 8000 }).toBe('frame 42');
});

test('remotion studio: frame is read live while playing, and adding a note pauses at a stable frame', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(STUDIO);
  await expect(page.locator('button.__remotion_input_dragger[aria-label="Frame Rate"]')).toHaveText('30fps');
  const panel = await h.openPanel(page);
  await panel.getByTestId('btn-review').click();
  await expect(page.getByTestId('toolbar')).toBeVisible();
  await page.evaluate(() => (window as any).remotion_setFrame(10, 'Hello'));
  await expect(panel.getByTestId('tab-time')).toContainText('frame 10');

  // start playback (Space toggles it in the Studio) and watch the frame advance in the panel
  await page.keyboard.press('Space');
  await expect.poll(async () => Number(/frame (\d+)/.exec((await panel.getByTestId('tab-time').textContent()) ?? '')?.[1] ?? 0), { timeout: 8000 }).toBeGreaterThan(20);

  await page.getByTestId('btn-add-note').click(); // pauses the preview
  await page.getByTestId('note-text').fill('Added while playing');
  await page.getByTestId('note-save').click();
  await expect(page.getByTestId('toast')).toContainText('Note saved');
  const noteFrame = Number(/frame (\d+)/.exec((await panel.getByTestId('note-card').first().getByTestId('note-time').textContent()) ?? '')?.[1]);
  await page.waitForTimeout(400);
  const shown = Number(/frame (\d+)/.exec((await frameText(page)) ?? '')?.[1]);
  expect(noteFrame).toBeGreaterThan(10);
  expect(Math.abs(shown - noteFrame)).toBeLessThanOrEqual(6); // paused: preview stopped near the noted frame
});
