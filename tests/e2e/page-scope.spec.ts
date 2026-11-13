import { test, expect, PAGES, addNote, waitForVideo } from './fixtures';

test('"This page only" re-filters the list when the tab navigates', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(`${PAGES}/video.html`);
  await waitForVideo(page);

  const panel = await h.openPanel(page);
  await panel.getByTestId('btn-review').click();
  await expect(page.getByTestId('toolbar')).toBeVisible();
  await h.bringToFront(page);
  await addNote(page, 'Note on the video page');
  await expect(panel.getByTestId('note-card')).toHaveCount(1);

  await panel.getByTestId('scope-page').check();
  await expect(panel.getByTestId('note-card')).toHaveCount(1);

  // navigate the same tab to another page: the list must follow without any click
  await page.goto(`${PAGES}/plain.html`);
  await expect(panel.getByTestId('note-card')).toHaveCount(0);
  await expect(panel.getByTestId('empty')).toBeVisible();

  // and back again
  await page.goto(`${PAGES}/video.html`);
  await expect(panel.getByTestId('note-card')).toHaveCount(1);

  // unchecking shows everything regardless of the page
  await page.goto(`${PAGES}/plain.html`);
  await expect(panel.getByTestId('note-card')).toHaveCount(0);
  await panel.getByTestId('scope-page').uncheck();
  await expect(panel.getByTestId('note-card')).toHaveCount(1);
});
