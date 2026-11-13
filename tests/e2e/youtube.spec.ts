import { test, expect, addNote, startReview } from './fixtures';

// Real YouTube needs network and may show a consent wall / ads: skip gracefully instead of failing.
test('youtube: adapter detects the player, notes carry the timestamp, click seeks back', async ({ h }) => {
  test.setTimeout(120_000);
  const page = await h.context.newPage();
  try {
    await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    test.skip(true, `YouTube not reachable: ${e instanceof Error ? e.message : e}`);
  }
  if (/consent\./.test(page.url())) test.skip(true, 'YouTube consent wall');
  const ready = await page
    .waitForFunction(() => ((document.querySelector('video.html5-main-video') as HTMLVideoElement | null)?.readyState ?? 0) >= 2, undefined, { timeout: 30_000 })
    .then(() => true, () => false);
  test.skip(!ready, 'YouTube player did not become ready (consent/bot wall or blocked)');
  const ad = await page.evaluate(() => !!document.querySelector('.html5-video-player.ad-showing'));
  test.skip(ad, 'an ad is playing');

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const v = document.querySelector('video.html5-main-video') as HTMLVideoElement;
        v.pause();
        v.addEventListener('seeked', () => resolve(), { once: true });
        v.currentTime = 7;
      }),
  );
  const panel = await h.openPanel(page);
  await startReview(panel, page);
  await expect(panel.getByTestId('tab-adapter')).toHaveText('YouTube');
  await addNote(page, 'Zoo shot is shaky');
  const card = panel.getByTestId('note-card').first();
  await expect(card.getByTestId('note-time')).toContainText('00:07.');

  await page.evaluate(() => ((document.querySelector('video.html5-main-video') as HTMLVideoElement).currentTime = 14));
  await card.getByTestId('note-goto').click();
  await expect.poll(() => page.evaluate(() => (document.querySelector('video.html5-main-video') as HTMLVideoElement).currentTime), { timeout: 15_000 }).toBeLessThan(8.5);
});
