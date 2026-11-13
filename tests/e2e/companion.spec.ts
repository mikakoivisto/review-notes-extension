import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect, PAGES, addNote, drag, seekVideo, startReview, waitForVideo } from './fixtures';

async function startCompanion(dir: string): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [resolve('dist/companion/cli.js'), 'serve', '--dir', dir, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((res, rej) => {
    const t = setTimeout(() => rej(new Error('companion did not start')), 10_000);
    child.stdout!.on('data', (d: Buffer) => {
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d));
      if (m) {
        clearTimeout(t);
        res(m[1]);
      }
    });
  });
  return { child, url };
}

test('companion: notes sync to files, an MCP client reads them and marks one fixed, the panel shows it', async ({ h }) => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-companion-'));
  const { child, url } = await startCompanion(dir);
  try {
    // 1. enable sync in the options page
    const options = await h.context.newPage();
    await options.goto(`chrome-extension://${h.extensionId}/options.html`);
    await options.getByTestId('companion-url').fill(url);
    await options.getByTestId('sync-enabled').check();
    await options.getByTestId('save-settings').click();
    await options.getByTestId('test-sync').click();
    await expect(options.getByTestId('options-status')).toContainText('Connected');

    // 2. make a note on a video
    const page = await h.context.newPage();
    await page.goto(`${PAGES}/video.html`);
    await waitForVideo(page);
    await seekVideo(page, 4);
    const panel = await h.openPanel(page);
    await startReview(panel, page);
    await page.getByTestId('tool-box').click();
    await drag(page, [0.3, 0.3], [0.6, 0.6]);
    await addNote(page, 'Fix the colour banding here');
    await expect(panel.getByTestId('note-card')).toHaveCount(1);

    // 3. it lands in the store as plain files (zero-setup path for any agent)
    await expect.poll(() => (existsSync(join(dir, 'notes.json')) ? JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8')).notes.length : 0), { timeout: 15_000 }).toBe(1);
    const stored = JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8')).notes[0];
    expect(stored).toMatchObject({ text: 'Fix the colour banding here', status: 'open', adapter: 'html5-video' });
    await expect.poll(() => existsSync(join(dir, 'screenshots', `${stored.id}.png`)) && existsSync(join(dir, 'screenshots', `${stored.id}.clean.png`)), { timeout: 15_000 }).toBe(true);
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain('Fix the colour banding here');

    // 4. an MCP client (streamable HTTP) pulls the note, looks at the screenshot, marks it fixed
    const client = new Client({ name: 'e2e', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    const list = await client.callTool({ name: 'list_notes', arguments: {} });
    const listText = (list.content as { type: string; text: string }[])[0].text;
    expect(listText).toContain('Fix the colour banding here');
    expect(listText).toContain('00:04.00');
    const shot = await client.callTool({ name: 'get_screenshot', arguments: { id: stored.id } });
    expect((shot.content as { type: string }[]).some((c) => c.type === 'image')).toBe(true);
    await client.callTool({ name: 'mark_fixed', arguments: { id: '#1', reply: 'Raised bitrate to 8 Mbps' } });
    await client.close();

    // 5. the extension pulls the agent's change
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'sync:now' }));
    const card = panel.getByTestId('note-card').first();
    await expect(card.getByTestId('note-status-badge')).toHaveText('Fixed');
    await expect(card.getByTestId('note-reply')).toContainText('Raised bitrate to 8 Mbps');
    await expect(panel.getByTestId('sync-status')).toContainText('synced');

    // 6. deletes propagate too
    await card.getByTestId('note-delete').click();
    await card.getByTestId('note-delete').click();
    await expect.poll(() => JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8')).notes.length, { timeout: 15_000 }).toBe(0);
  } finally {
    child.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('companion offline: local notes keep working and the panel says so', async ({ h }) => {
  const options = await h.context.newPage();
  await options.goto(`chrome-extension://${h.extensionId}/options.html`);
  await options.getByTestId('companion-url').fill('http://127.0.0.1:1'); // nothing listens here
  await options.getByTestId('sync-enabled').check();
  await options.getByTestId('save-settings').click();
  await options.getByTestId('test-sync').click();
  await expect(options.getByTestId('options-status')).toContainText('Error');

  const page = await h.context.newPage();
  await page.goto(`${PAGES}/plain.html`);
  const panel = await h.openPanel(page);
  await startReview(panel, page);
  await addNote(page, 'works offline');
  await expect(panel.getByTestId('note-card')).toHaveCount(1);
  await expect(panel.getByTestId('sync-status')).toContainText('offline');
});
