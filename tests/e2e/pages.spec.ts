import { test, expect, PAGES, addNote, drag, readStoredScreenshot, seekVideo, startReview, thumbWidth, waitForVideo } from './fixtures';

test('strict-CSP page: overlay still mounts (constructable stylesheets) and notes are saved', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(`${PAGES}/csp.html`);
  await waitForVideo(page);
  await seekVideo(page, 2);
  const panel = await h.openPanel(page);
  await startReview(panel, page);
  // the toolbar must actually be laid out (not an unstyled blob) even with style-src 'none'
  const bar = await page.getByTestId('toolbar').boundingBox();
  expect(bar!.width).toBeGreaterThan(300);
  await page.getByTestId('tool-pen').click();
  await drag(page, [0.2, 0.2], [0.6, 0.6]);
  await addNote(page, 'On a CSP page');
  await expect(page.getByTestId('toast')).toContainText('Note saved');
  const card = panel.getByTestId('note-card').first();
  await expect(card.getByTestId('note-time')).toContainText('00:02.00');
  expect(await thumbWidth(card)).toBeGreaterThan(100);
});

test('black (DRM-like) video: screenshot is flagged, note + timecode + drawing are kept', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(`${PAGES}/black.html`);
  await waitForVideo(page);
  await seekVideo(page, 1);
  const panel = await h.openPanel(page);
  await startReview(panel, page);
  await page.getByTestId('tool-box').click();
  await drag(page, [0.1, 0.1], [0.4, 0.4]);
  await addNote(page, 'Cannot see anything');
  await expect(page.getByTestId('toast')).toContainText('looks black');
  const card = panel.getByTestId('note-card').first();
  await expect(card.getByTestId('black-warning')).toBeVisible();
  await expect(card.getByTestId('note-time')).toContainText('00:01.00');
  // the *annotated* image still contains our red box, so it is not "all black"
  const id = (await card.getAttribute('data-note-id'))!;
  expect(await readStoredScreenshot(panel, id, 'annotated')).not.toBeNull();
  expect(await readStoredScreenshot(panel, id, 'clean')).not.toBeNull();
});

test('plain page (no media): page note keeps scroll position, go-to restores it, no timecode', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(`${PAGES}/plain.html`);
  await page.evaluate(() => window.scrollTo(0, 700));
  const panel = await h.openPanel(page);
  await startReview(panel, page);
  await expect(panel.getByTestId('tab-adapter')).toHaveText('Web page');
  await expect(panel.getByTestId('tab-time')).toHaveText('no timecode');
  await page.getByTestId('tool-circle').click();
  await drag(page, [0.2, 0.3], [0.5, 0.5]);
  await addNote(page, 'Heading is misaligned');
  const card = panel.getByTestId('note-card').first();
  await expect(card.getByTestId('note-time')).toHaveText('page');
  await page.evaluate(() => window.scrollTo(0, 0));
  await card.getByTestId('note-goto').click();
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 8000 }).toBe(700);
});

test('screenshot-only fallback note (no injection needed) and unsupported pages explain themselves', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(`${PAGES}/plain.html`);
  const panel = await h.openPanel(page);
  await panel.getByTestId('btn-shot').click();
  const card = panel.getByTestId('note-card').first();
  await expect(card).toBeVisible();
  expect(await thumbWidth(card)).toBeGreaterThan(100);
  await expect(card.getByTestId('note-time')).toHaveText('page');

  const chromePage = await h.context.newPage();
  await chromePage.goto('chrome://version');
  const panel2 = await h.openPanel(chromePage);
  await panel2.getByTestId('btn-review').click();
  await expect(panel2.getByTestId('error')).toContainText('cannot be annotated');
  // Chrome refuses capture on chrome:// pages from the panel button (verified): an error, never a bogus note
  const before = await panel2.getByTestId('note-card').count();
  await panel2.getByTestId('btn-shot').click();
  await expect(panel2.getByTestId('error')).toBeVisible();
  await expect(panel2.getByTestId('error')).toContainText(/activeTab|cannot|permission/i);
  expect(await panel2.getByTestId('note-card').count()).toBe(before);
});

test('panel: filter by status, edit text/type, delete with confirmation', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(`${PAGES}/plain.html`);
  const panel = await h.openPanel(page);
  await startReview(panel, page);
  for (const t of ['first', 'second', 'third']) {
    await addNote(page, t);
    await expect(page.getByTestId('toast')).toContainText('Note saved');
    await page.waitForTimeout(700); // keep createdAt ordering and respect captureVisibleTab rate limit
  }
  await expect(panel.getByTestId('note-card')).toHaveCount(3);
  await expect(panel.getByTestId('filter-open')).toContainText('3');

  // newest first
  await expect(panel.getByTestId('note-card').first().getByTestId('note-text')).toHaveText('third');
  await panel.getByTestId('note-card').nth(1).getByTestId('note-status').selectOption('fixed');
  await expect(panel.getByTestId('filter-fixed')).toContainText('1');
  await panel.getByTestId('filter-fixed').click();
  await expect(panel.getByTestId('note-card')).toHaveCount(1);
  await expect(panel.getByTestId('note-card').first().getByTestId('note-text')).toHaveText('second');
  await panel.getByTestId('filter-open').click();
  await expect(panel.getByTestId('note-card')).toHaveCount(2);

  const firstId = await panel.getByTestId('note-card').filter({ hasText: 'first' }).getAttribute('data-note-id');
  const first = panel.locator(`[data-note-id="${firstId}"]`);
  await first.getByTestId('note-edit').click();
  await first.getByTestId('edit-text').fill('first (edited)');
  await first.getByTestId('edit-type').selectOption('timing');
  await first.getByTestId('edit-save').click();
  await expect(first).toContainText('first (edited)');
  await expect(first).toContainText('timing');

  const target = panel.getByTestId('note-card').filter({ hasText: 'third' });
  await target.getByTestId('note-delete').click();
  await expect(target.getByTestId('note-delete')).toHaveText('Confirm delete?');
  await target.getByTestId('note-delete').click();
  await expect(panel.getByTestId('note-card')).toHaveCount(1);
  await panel.getByTestId('filter-all').click();
  await expect(panel.getByTestId('note-card')).toHaveCount(2);
});

test('service worker is stateless: killing it mid-session loses nothing', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(`${PAGES}/video.html`);
  await waitForVideo(page);
  await seekVideo(page, 1);
  const panel = await h.openPanel(page);
  await startReview(panel, page);
  await page.getByTestId('tool-box').click();
  await drag(page, [0.2, 0.2], [0.4, 0.4]);
  await addNote(page, 'before restart');
  await expect(panel.getByTestId('note-card')).toHaveCount(1);

  // mark the running worker; a restarted worker will not have the marker (the panel polls, so it restarts at once)
  await h.sw.evaluate(() => ((globalThis as { __marker?: number }).__marker = 1));
  const cdp = await h.context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect
    .poll(async () => {
      const ws = h.context.serviceWorkers();
      if (!ws.length) return 'none';
      return ws[ws.length - 1].evaluate(() => (globalThis as { __marker?: number }).__marker ?? 'fresh').catch(() => 'dead');
    }, { timeout: 15_000 })
    .toMatch(/fresh|none|dead/);

  await seekVideo(page, 4);
  await drag(page, [0.5, 0.5], [0.7, 0.7]);
  await addNote(page, 'after restart');
  await expect(panel.getByTestId('note-card')).toHaveCount(2);
  await expect(panel.getByTestId('note-card').first().getByTestId('note-time')).toContainText('00:04.00');
  await expect(panel.getByTestId('note-card').nth(1).getByTestId('note-text')).toHaveText('before restart');
});
