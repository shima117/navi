import { defineConfig } from 'playwright/test';

/**
 * Electron e2e (PR-10 acceptance G). Run with `npm run test:e2e`, which builds
 * first and wraps the run in xvfb-run on a display-less Linux box.
 * One worker: every test binds the fixed Ollama / VOICEVOX ports.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  // Ignored by git (dist-electron/); only written on failures.
  outputDir: '../dist-electron/e2e-results',
});
