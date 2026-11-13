import { test, expect, PAGES, addNote, drag, seekVideo, thumbWidth, waitForVideo } from './fixtures';

test('video: draw, add note, see it in the panel with screenshot + timecode, click to seek back', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(`${PAGES}/video.html`);
  await waitForVideo(page);
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
  await addNote(page, 'Logo is too small');
  await expect(page.getByTestId('toast')).toContainText('Note saved');

  const card = panel.getByTestId('note-card').first();
  await expect(card).toBeVisible();
  await expect(card.getByTestId('note-time')).toContainText('00:03.00');
  await expect(card.getByTestId('note-text')).toHaveText('Logo is too small');
  const natural = await thumbWidth(card);
  expect(natural).toBeGreaterThan(100);

  await seekVideo(page, 6.5);
  await card.getByTestId('note-goto').click();
  await expect.poll(() => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime), { timeout: 8000 }).toBeCloseTo(3, 0);
});
