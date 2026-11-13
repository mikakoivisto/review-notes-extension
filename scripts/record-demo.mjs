// Records the demo: runs the paced Playwright demo (recordVideo on every page), then stitches the page
// window and the notes-panel window side by side with ffmpeg and extracts stills. Output -> demo/
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = resolve('demo');
const RAW = join(OUT, 'raw');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};

run('npx', ['playwright', 'test', '-c', 'playwright.demo.config.ts'], { PW_VIDEO_DIR: RAW, DEMO_OUT: OUT });

const tl = JSON.parse(readFileSync(join(OUT, 'timeline.json'), 'utf8'));
const { main, panel } = tl.pages;
if (!main.video || !panel.video || !existsSync(main.video) || !existsSync(panel.video)) throw new Error('missing recorded videos: ' + JSON.stringify(tl.pages));

// Both recordings are 1100x760 canvases; the panel window (440 px wide) sits in the top-left corner.
const pad = panel.startOffsetSec.toFixed(2);
const filter = [
  `[0:v]fps=25,scale=1100:760,setsar=1[a]`,
  `[1:v]fps=25,crop=440:760:0:0,setsar=1,tpad=start_duration=${pad}:start_mode=add:color=0x111827[b]`,
  `[a][b]hstack=inputs=2:shortest=1[v]`,
].join(';');
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', main.video, '-i', panel.video, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libvpx-vp9', '-b:v', '1.6M', '-deadline', 'good', '-cpu-used', '4', join(OUT, 'demo.webm')]);
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(OUT, 'demo.webm'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', join(OUT, 'demo.mp4')]);

// Stills of the stitched video at the milestones (page window + notes panel together)
const stills = { paused: '00-paused-video', draw: '10-drawing-tools', list: '11-note-with-screenshot-and-timecode', seek: '12-before-seek', export: '13-export', mcp: '14-mcp-list-notes', fixed: '15-agent-marked-fixed' };
for (const [k, name] of Object.entries(stills)) {
  const t = tl.marks[k];
  if (t === undefined) continue;
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, t + (k === 'mcp' || k === 'fixed' ? 0.5 : 0.3))), '-i', join(OUT, 'demo.mp4'), '-frames:v', '1', join(OUT, `${name}.png`)]);
}
rmSync(RAW, { recursive: true, force: true });
// "a few PNGs": keep the stitched milestone stills plus two page-level close-ups, drop the rest
for (const f of ['01-review-toolbar.png', '03-composer.png', '04-notes-panel.png', '06-mcp-list-notes.png', '07-panel-fixed-by-agent.png']) rmSync(join(OUT, f), { force: true });
tl.shots = tl.shots.filter((f) => existsSync(join(OUT, f)));
// keep the timeline portable: no absolute temp paths
for (const p of Object.values(tl.pages)) p.video = p.video ? 'raw/' + p.video.split('/').pop() : null;
writeFileSync(join(OUT, 'timeline.json'), JSON.stringify(tl, null, 2) + '\n');
console.log('demo files:', readdirSync(OUT).join(', '));
