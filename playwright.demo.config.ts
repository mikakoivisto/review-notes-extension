import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Same web servers as the e2e config; only the demo spec, with generous timeout (paced for humans).
export default defineConfig({ ...base, testDir: 'tests/demo', timeout: 240_000, outputDir: 'test-results-demo' });
