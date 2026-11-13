import { readFileSync } from 'node:fs';
import { test, expect, PAGES, addNote, drag, seekVideo, startReview, thumbWidth, waitForVideo } from './fixtures';
import { readZip } from '../../src/shared/zip';

test('export zip (JSON + Markdown + screenshots) and import it back after deleting', async ({ h }) => {
  const page = await h.context.newPage();
  await page.goto(`${PAGES}/video.html`);
  await waitForVideo(page);
  await seekVideo(page, 5);
  const panel = await h.openPanel(page);
  await startReview(panel, page);
  await page.getByTestId('tool-arrow').click();
  await drag(page, [0.2, 0.8], [0.5, 0.5]);
  await addNote(page, 'Export me');
  await expect(panel.getByTestId('note-card')).toHaveCount(1);

  const [download] = await Promise.all([panel.waitForEvent('download'), panel.getByTestId('btn-export').click()]);
  expect(download.suggestedFilename()).toMatch(/^review-notes-\d{4}-\d{2}-\d{2}\.zip$/);
  const zipPath = (await download.path())!;
  const files = await readZip(new Uint8Array(readFileSync(zipPath)));
  const names = [...files.keys()].sort();
  expect(names).toContain('notes.json');
  expect(names).toContain('notes.md');
  expect(names.filter((n) => n.startsWith('screenshots/') && n.endsWith('.png')).length).toBe(2); // annotated + clean
  const json = JSON.parse(new TextDecoder().decode(files.get('notes.json')));
  expect(json).toMatchObject({ schemaVersion: 1, notes: [{ text: 'Export me', adapter: 'html5-video', time: { seconds: expect.closeTo(5, 0) }, type: 'visual' }] });
  expect(json.notes[0].annotation.shapes[0].t).toBe('arrow');
  const md = new TextDecoder().decode(files.get('notes.md'));
  expect(md).toContain('00:05.0');
  expect(md).toContain('Export me');
  expect(md).toContain(`![note 1](screenshots/${json.notes[0].id}.png)`);
  const png = files.get(`screenshots/${json.notes[0].id}.png`)!;
  expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);

  // delete, then import
  const card = panel.getByTestId('note-card').first();
  await card.getByTestId('note-delete').click();
  await card.getByTestId('note-delete').click();
  await expect(panel.getByTestId('note-card')).toHaveCount(0);

  await panel.getByTestId('file-import').setInputFiles(zipPath);
  await expect(panel.getByTestId('msg')).toContainText('1 added');
  const restored = panel.getByTestId('note-card').first();
  await expect(restored.getByTestId('note-text')).toHaveText('Export me');
  await expect(restored.getByTestId('note-time')).toContainText('00:05.0');
  expect(await thumbWidth(restored)).toBeGreaterThan(100);

  // importing the same file again changes nothing
  await panel.getByTestId('file-import').setInputFiles(zipPath);
  await expect(panel.getByTestId('msg')).toContainText('1 unchanged');
  await expect(panel.getByTestId('note-card')).toHaveCount(1);

  // a bare notes.json (no screenshots) imports too
  await expect(panel.getByTestId('error')).toBeHidden();
});
