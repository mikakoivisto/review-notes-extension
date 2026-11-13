// Builds the extension (dist/extension) and the companion (dist/companion) with esbuild.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const ext = 'dist/extension';
rmSync('dist', { recursive: true, force: true });
mkdirSync(ext, { recursive: true });

const common = { bundle: true, minify: true, sourcemap: false, logLevel: 'info', target: 'chrome116', legalComments: 'none' };

const extEntries = {
  background: 'src/background/service-worker.ts',
  content: 'src/content/content.ts',
  bridge: 'src/content/bridge-main.ts',
  sidepanel: 'src/sidepanel/sidepanel.ts',
  options: 'src/options/options.ts',
};

const jobs = [
  { ...common, entryPoints: extEntries, outdir: ext, format: 'iife', platform: 'browser' },
  {
    entryPoints: { cli: 'src/companion/cli.ts' },
    outdir: 'dist/companion',
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    packages: 'external',
    logLevel: 'info',
    banner: { js: '#!/usr/bin/env node' },
  },
];

function copyStatic() {
  cpSync('static', ext, { recursive: true });
  for (const f of ['sidepanel', 'options']) {
    cpSync(`src/${f}/${f}.html`, `${ext}/${f}.html`);
    cpSync(`src/${f}/${f}.css`, `${ext}/${f}.css`);
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const manifest = JSON.parse(readFileSync(`${ext}/manifest.json`, 'utf8'));
  manifest.version = pkg.version;
  writeFileSync(`${ext}/manifest.json`, JSON.stringify(manifest, null, 2));
}

if (watch) {
  for (const j of jobs) (await context(j)).watch();
  copyStatic();
} else {
  for (const j of jobs) await build(j);
  copyStatic();
}
