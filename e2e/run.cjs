// Runs the Electron e2e suite with Playwright Test (`npm run test:e2e` builds first).
// On a Linux box without a display the run is wrapped in `xvfb-run -a`.
// Extra arguments are passed through, e.g. `npm run test:e2e -- -g "Diagnostics"`.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
const args = [cli, 'test', '--config', path.join(__dirname, 'playwright.config.ts'), ...process.argv.slice(2)];

const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const [cmd, cmdArgs] = headless ? ['xvfb-run', ['-a', process.execPath, ...args]] : [process.execPath, args];

const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root });
if (result.error) {
  console.error(`[e2e] could not start ${cmd}:`, result.error.message);
  if (headless) console.error('[e2e] install xvfb (xvfb-run) or run with a DISPLAY.');
  process.exit(1);
}
process.exit(result.status ?? 1);
