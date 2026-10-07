import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from 'playwright/test';
import { startFakeOllama, startFakeVoicevox, type FakeService } from './fakeServices.cjs';

/**
 * End-to-end acceptance (design doc 受入テスト G, PR-10): the real app with
 * fake Ollama / VOICEVOX. Each test gets its own profile dir (NAVI_USER_DATA)
 * and starts only the services it wants up.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// From Node, the electron package resolves to the path of its binary.
const ELECTRON_BIN = createRequire(import.meta.url)('electron') as unknown as string;

interface Running {
  app: ElectronApplication;
  page: Page;
  userData: string;
}

const cleanups: Array<() => Promise<void>> = [];

test.afterEach(async () => {
  // Reverse order: app first, then the fake services it was talking to.
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch (err) {
      console.error('[e2e] cleanup failed', err);
    }
  }
});

async function services(which: { ollama?: boolean; voicevox?: boolean }) {
  const out: { ollama?: FakeService<{ chat: number; requests: number }>; voicevox?: FakeService<{ synthesis: number; requests: number }> } = {};
  if (which.ollama) out.ollama = await startFakeOllama();
  if (which.ollama) cleanups.push(() => out.ollama!.close());
  if (which.voicevox) out.voicevox = await startFakeVoicevox();
  if (which.voicevox) cleanups.push(() => out.voicevox!.close());
  return out;
}

async function launch(): Promise<Running> {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'navi-e2e-'));
  cleanups.push(() => rm(userData, { recursive: true, force: true }));
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: ROOT,
    env: { ...process.env, NAVI_USER_DATA: userData },
    timeout: 30_000,
  });
  cleanups.push(async () => {
    const proc = app.process();
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10_000))]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  });
  const page = await mainWindow(app);
  await expect(page.locator('header .brand')).toHaveText('NAVI');
  return { app, page, userData };
}

async function mainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const page = app.windows().find((w) => w.url().endsWith('/index.html'));
    if (page) return page;
    await app.waitForEvent('window', { timeout: 2_000 }).catch(() => undefined);
  }
  throw new Error('main window did not open');
}

async function say(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder('ナビに話しかける…');
  await input.fill(text);
  await input.press('Enter');
  await expect(page.locator('.line.user .text').last()).toHaveText(`「${text}」`);
}

const naviLines = (page: Page) => page.locator('.line.navi .text');
const aiPill = (page: Page) => page.locator('header .pill').first();

test('text chat round trip (no STT running: typing still works)', async () => {
  const svc = await services({ ollama: true, voicevox: true });
  const { page } = await launch();
  await expect(aiPill(page)).toHaveText('● LOCAL');
  await expect(page.locator('header')).toContainText('🎙 OFF');

  await say(page, '今日仕事だるかった');
  await expect(naviLines(page).last()).toHaveText('「お疲れさまです。まあ私も今日は何もしたくないですけど」');

  // Customer-service phrases are stripped end to end (§8.3).
  await say(page, 'ねえ');
  await expect(naviLines(page)).toHaveCount(2);
  await expect(naviLines(page).last()).toHaveText('「不愉快です。」');
  await expect(page.locator('.log')).not.toContainText('他に何か');
  await expect.poll(() => svc.voicevox!.stats.synthesis).toBeGreaterThanOrEqual(1);
});

test('Ollama down at start: app stays up, shows AI offline, typing works, then reconnects', async () => {
  await services({ voicevox: true });
  const { app, page } = await launch();
  await expect(aiPill(page)).toHaveText('AI offline');

  await say(page, 'おーい');
  await page.waitForTimeout(1_500);
  await expect(naviLines(page)).toHaveCount(0);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThanOrEqual(1);
  expect(page.isClosed()).toBe(false);

  // Ollama comes back: the §19 backoff (1, 2, 5, 10 s) picks it up without a restart.
  const ollama = await startFakeOllama();
  cleanups.push(() => ollama.close());
  await expect(aiPill(page)).toHaveText('● LOCAL', { timeout: 30_000 });
  await say(page, '今日仕事だるかった');
  await expect(naviLines(page).last()).toContainText('お疲れさまです');
});

test('VOICEVOX down: subtitles still appear', async () => {
  await services({ ollama: true });
  const { page } = await launch();
  await expect(aiPill(page)).toHaveText('● LOCAL');
  await expect(page.locator('footer .status')).toContainText('TTS: subtitles only');

  await say(page, '今日仕事だるかった');
  await expect(naviLines(page).last()).toHaveText('「お疲れさまです。まあ私も今日は何もしたくないですけど」');
});

test('avatar window closed: the conversation continues', async () => {
  await services({ ollama: true, voicevox: true });
  const { app, page } = await launch();
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('/avatar.html'))).toBe(true);

  const closed = await app.evaluate(({ BrowserWindow }) => {
    const avatar = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/avatar.html'));
    avatar?.close();
    return Boolean(avatar);
  });
  expect(closed).toBe(true);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

  await say(page, '今日仕事だるかった');
  await expect(naviLines(page).last()).toContainText('お疲れさまです');
});

test('Diagnostics tab renders, logs locally and exports without conversation text', async () => {
  await services({ ollama: true, voicevox: true });
  const { app, page, userData } = await launch();
  await expect(aiPill(page)).toHaveText('● LOCAL');

  await page.getByRole('button', { name: '診断', exact: true }).click();
  await expect(page.getByRole('heading', { name: '診断' })).toBeVisible();
  await expect(page.locator('[data-service="chat"]')).toContainText('OK');
  await expect(page.locator('[data-service="stt"]')).toContainText('offline');
  await expect(page.getByTestId('resource-mode')).toHaveText('DESKTOP_CHAT');
  for (const id of ['voice-service', 'voicevox', 'ollama']) {
    await expect(page.locator(`[data-process="${id}"] .pill`)).toHaveText('無効');
  }

  // Local JSONL log on, then a conversation turn.
  // Controlled checkboxes flip once main has saved the setting, so click and then wait.
  const toFile = page.getByLabel('指標をファイルにも記録する (数値と状態のみ)');
  await toFile.click();
  await expect(toFile).toBeChecked();
  await page.getByRole('button', { name: 'Friend' }).click();
  await say(page, '今日仕事だるかった');
  await expect(naviLines(page).last()).toContainText('お疲れさまです');

  await page.getByRole('button', { name: '診断', exact: true }).click();
  await expect(page.locator('[data-latency="chat"] .diag-count')).not.toHaveText('0');
  await expect(page.locator('section', { hasText: '自発発言' })).toContainText('見送り');

  const logFile = path.join(userData, 'logs', 'telemetry.jsonl');
  await expect.poll(async () => (await stat(logFile).catch(() => null))?.size ?? 0).toBeGreaterThan(0);
  const log = await readFile(logFile, 'utf8');
  expect(log).toContain('"type":"timing"');
  expect(log).not.toMatch(/仕事|お疲れ/);

  // 「診断情報を書き出す」 with the save dialog answered by the test.
  const out = path.join(userData, 'diagnostics.json');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as unknown as typeof dialog.showSaveDialog;
  }, out);
  await page.getByRole('button', { name: '診断情報を書き出す' }).click();
  await expect(page.getByText('保存しました')).toBeVisible();
  const raw = await readFile(out, 'utf8');
  const report = JSON.parse(raw) as { format: string; metrics: { latency: { chat: { count: number } } }; services: Array<{ name: string; ok: boolean }> };
  expect(report.format).toBe('navi-diagnostics');
  expect(report.metrics.latency.chat.count).toBeGreaterThanOrEqual(1);
  expect(report.services.find((s) => s.name === 'chat')?.ok).toBe(true);
  expect(raw).not.toMatch(/仕事|お疲れ|ユーザー/);
});

test('watchdog: an already-running service is left alone, a crashing helper is restarted', async () => {
  await services({ ollama: true });
  const { page } = await launch();
  await page.getByRole('button', { name: '診断', exact: true }).click();

  // Ollama is already serving :11434, so enabling it must not spawn a second one.
  const ollama = page.locator('[data-process="ollama"]');
  await ollama.locator('summary', { hasText: '設定' }).click();
  await ollama.getByLabel('NAVI から起動して監視する').check();
  await ollama.getByRole('button', { name: '保存して適用' }).click();
  await expect(ollama.locator('.pill')).toHaveText('外部で起動済み');

  // A "voice service" that dies at once (node rejects `-m`): restarted with backoff, stderr captured.
  const voice = page.locator('[data-process="voice-service"]');
  await voice.locator('summary', { hasText: '設定' }).click();
  await voice.getByLabel('NAVI から起動して監視する').check();
  await voice.getByLabel('Python 実行ファイル').fill(process.execPath);
  await voice.getByLabel('作業フォルダ').fill(os.tmpdir());
  await voice.getByRole('button', { name: '保存して適用' }).click();
  await expect(voice).toContainText(/自動再起動: [1-9]/, { timeout: 20_000 });
  await voice.locator('summary', { hasText: '直近のエラー出力' }).click();
  await expect(voice.locator('.diag-stderr')).toContainText('-m');
  await expect(page.locator('.diag-errors')).toContainText('process:voice-service');

  // Turning it off stops supervising.
  await voice.getByLabel('NAVI から起動して監視する').uncheck();
  await voice.getByRole('button', { name: '保存して適用' }).click();
  await expect(voice.locator('.pill')).toHaveText('無効');
});
