import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from '@playwright/test';
import { test, expect, PAGES, drag, seekVideo, waitForVideo } from '../e2e/fixtures';

const OUT = process.env.DEMO_OUT || resolve('demo');
const RAW = process.env.PW_VIDEO_DIR || join(OUT, 'raw');

// A visible mouse pointer (Playwright videos do not draw one). Hidden while the extension takes a screenshot.
const CURSOR = `(() => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;z-index:2147483646;width:18px;height:18px;border-radius:50%;background:rgba(250,204,21,.85);border:2px solid #92400e;pointer-events:none;left:-50px;top:-50px;transform:translate(-50%,-50%);transition:opacity .15s';
  let last = 0;
  addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; last = performance.now(); }, true);
  const tick = () => {
    const capturing = !!document.getElementById('review-notes-root')?.hasAttribute('data-capturing');
    d.style.opacity = capturing || performance.now() - last > 2500 ? '0' : '1';
    requestAnimationFrame(tick);
  };
  const mount = () => { (document.documentElement).appendChild(d); tick(); };
  document.documentElement ? mount() : addEventListener('DOMContentLoaded', mount);
})();`;

test('demo: review a video, note it, seek back, export, and read it from an MCP client', async ({ h }) => {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(RAW, { recursive: true });
  const storeDir = mkdtempSync(join(tmpdir(), 'rn-demo-'));
  const child = spawn(process.execPath, [resolve('dist/companion/cli.js'), 'serve', '--dir', storeDir, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((res, rej) => {
    setTimeout(() => rej(new Error('companion did not start')), 10_000);
    child.stdout!.on('data', (d: Buffer) => /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d)) && res(/listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d))![1]));
  });
  await h.sw.evaluate((u) => chrome.storage.local.set({ settings: { syncEnabled: true, companionUrl: u } }), url);

  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const mark = (k: string) => (marks[k] = (Date.now() - t0) / 1000);
  const pace = (p: Page, ms: number) => p.waitForTimeout(ms);
  const shots: string[] = [];
  const shot = async (p: Page, name: string) => {
    await p.screenshot({ path: join(OUT, name) });
    shots.push(name);
  };

  try {
    // 1. open the video page, play a moment, pause on a frame
    const main = await h.context.newPage();
    const mainCreatedAt = Date.now();
    await main.addInitScript(CURSOR);
    await main.goto(`${PAGES}/video.html`);
    await waitForVideo(main);
    await pace(main, 800);
    await main.evaluate(() => (document.querySelector('video') as HTMLVideoElement).play());
    await pace(main, 2200);
    await seekVideo(main, 3);
    mark('paused');
    await pace(main, 900);

    // 2. open the notes panel (own window) and start the review
    const panelCreatedAt = Date.now();
    const panel = await h.openPanel(main);
    await pace(panel, 1200);
    await panel.getByTestId('btn-review').click();
    await expect(main.getByTestId('toolbar')).toBeVisible();
    await pace(main, 1200);
    await shot(main, '01-review-toolbar.png');

    // 3. draw: box, arrow, text
    mark('draw');
    await main.getByTestId('tool-box').click();
    await pace(main, 400);
    await drag(main, [0.18, 0.22], [0.52, 0.55]);
    await pace(main, 500);
    await main.getByTestId('tool-arrow').click();
    await drag(main, [0.78, 0.8], [0.56, 0.58]);
    await pace(main, 400);
    await main.getByTestId('color-f59e0b').click();
    await main.getByTestId('tool-text').click();
    const cb = (await main.getByTestId('draw-canvas').boundingBox())!;
    await main.mouse.click(cb.x + cb.width * 0.58, cb.y + cb.height * 0.5);
    await main.getByTestId('text-input').pressSequentially('Logo too small', { delay: 60 });
    await main.keyboard.press('Enter');
    await pace(main, 1000);
    await shot(main, '02-annotation.png');

    // 4. add the note
    mark('note');
    await main.getByTestId('btn-add-note').click();
    await pace(main, 500);
    await main.getByTestId('note-text').pressSequentially('Logo is too small and too close to the edge', { delay: 45 });
    await main.getByTestId('note-type').selectOption('visual');
    await pace(main, 700);
    await shot(main, '03-composer.png');
    await main.getByTestId('note-save').click();
    await expect(main.getByTestId('toast')).toContainText('Note saved');

    // 5. it shows up in the panel with screenshot + timecode
    const card = panel.getByTestId('note-card').first();
    await expect(card.getByTestId('note-thumb')).toBeVisible();
    await expect(card.getByTestId('note-time')).toContainText('00:03.00');
    mark('list');
    await pace(panel, 2200);
    await shot(panel, '04-notes-panel.png');

    // 6. move the video away, click the note: it seeks back and shows the drawing again
    await seekVideo(main, 6.5);
    await pace(main, 1500);
    mark('seek');
    await card.getByTestId('note-goto').click();
    await expect.poll(() => main.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime), { timeout: 8000 }).toBeCloseTo(3, 0);
    await pace(main, 2500);
    await shot(main, '05-seek-back-with-ghost.png');

    // 6b. the panel's sync indicator
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'sync:now' }));
    await expect(panel.getByTestId('sync-status')).toContainText('synced');

    // 7. export
    mark('export');
    const [download] = await Promise.all([panel.waitForEvent('download'), panel.getByTestId('btn-export').click()]);
    await download.saveAs(join(OUT, 'demo-export.zip'));
    await expect(panel.getByTestId('msg')).toContainText('Exported 1 note');
    await pace(panel, 2000);

    // 8. an MCP client (what Claude Code / T3 Code does) lists the note — REAL call, shown in a console page
    const client = new Client({ name: 'demo-agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    await main.goto(`${PAGES}/console.html`);
    const log = async (cls: string, text: string) => main.evaluate(([c, t]) => { const m = document.getElementById('main')!; const e = document.createElement(c === 'out' ? 'pre' : 'div'); e.className = c; e.textContent = t; m.append(e); }, [cls, text]);
    await main.evaluate((u) => (document.getElementById('endpoint')!.textContent = u + '/mcp'), url);
    await pace(main, 800);
    await log('prompt', '$ agent → tools/call list_notes {}');
    const list = await client.callTool({ name: 'list_notes', arguments: {} });
    const listText = (list.content as { type: string; text: string }[])[0].text;
    expect(listText).toContain('Logo is too small');
    await log('out', listText.replace(storeDir, '<notes dir>'));
    mark('mcp');
    await pace(main, 2500);
    await shot(main, '06-mcp-list-notes.png');
    const note = (list.structuredContent as { notes: { id: string }[] }).notes[0];
    await log('prompt', `$ agent → tools/call get_screenshot { id: "${note.id}" }`);
    const img = await client.callTool({ name: 'get_screenshot', arguments: { id: note.id } });
    const image = (img.content as { type: string; data?: string }[]).find((c) => c.type === 'image')!;
    await log('out', `image/png, ${Math.round((image.data!.length * 3) / 4 / 1024)} KB (the agent sees the annotated frame)`);
    await pace(main, 1500);
    await log('prompt', '$ agent → tools/call mark_fixed { id: "#1", reply: "Logo scaled to 25% and moved inside the safe area" }');
    const fixed = await client.callTool({ name: 'mark_fixed', arguments: { id: '#1', reply: 'Logo scaled to 25% and moved inside the safe area' } });
    await log('out', (fixed.content as { text: string }[])[0].text);
    await client.close();
    await pace(main, 1500);

    // 9. the reviewer sees the agent's reply in the panel
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'sync:now' }));
    await expect(card.getByTestId('note-status-badge')).toHaveText('Fixed');
    await expect(card.getByTestId('note-reply')).toContainText('Logo scaled');
    mark('fixed');
    await pace(panel, 3000);
    await shot(panel, '07-panel-fixed-by-agent.png');

    writeFileSync(
      join(OUT, 'timeline.json'),
      JSON.stringify(
        {
          marks,
          shots,
          pages: {
            main: { startOffsetSec: 0, video: await main.video()!.path().catch(() => null) },
            panel: { startOffsetSec: (panelCreatedAt - mainCreatedAt) / 1000, video: await panel.video()!.path().catch(() => null) },
          },
        },
        null,
        2,
      ),
    );
    await main.close();
    await panel.close();
  } finally {
    child.kill('SIGTERM');
    rmSync(storeDir, { recursive: true, force: true });
  }
});
