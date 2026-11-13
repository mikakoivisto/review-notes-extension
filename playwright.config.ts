import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const haveRemotion = existsSync('examples/remotion-sample/node_modules/.bin/remotion');

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1, // one persistent Chromium with the extension; tests share nothing but are sequential
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  webServer: [
    { command: 'node tests/e2e/static-server.mjs', url: 'http://127.0.0.1:4173/video.html', reuseExistingServer: false, timeout: 20_000 },
    ...(haveRemotion
      ? [{ command: 'npm --prefix examples/remotion-sample run studio', url: 'http://localhost:3123/Hello', reuseExistingServer: false, timeout: 120_000, gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5000 } }]
      : []),
  ],
});
