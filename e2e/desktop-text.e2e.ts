import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from 'playwright/test';
import type {} from '../src/renderer/global';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_BIN = createRequire(import.meta.url)('electron') as unknown as string;
let app: ElectronApplication;
let main: Page;
let profile: string;

// No fake services or fixed port bindings: these display checks work with an existing Ollama.
test.beforeEach(async () => {
  profile = await mkdtemp(path.join(os.tmpdir(), 'navi-text-e2e-'));
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({
    audio: { voicemeeterAutoConfigure: false, listenSystemAudio: false, listenRemoteAudio: false },
    desktopText: { maxWidth: 520, maxLines: 4, fontSize: 28, temporarySeconds: 3 },
  }));
  app = await electron.launch({ executablePath: ELECTRON_BIN, args: ['.', '--no-sandbox'], cwd: ROOT,
    env: { ...process.env, NAVI_USER_DATA: profile, OPENAI_API_KEY: '' }, timeout: 30000 });
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('/index.html'))).toBe(true);
  main = app.windows().find((w) => w.url().endsWith('/index.html'))!;
  await expect(main.locator('header .brand')).toHaveText('NAVI');
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('/text-overlay.html'))).toBe(true);
});

test.afterEach(async () => {
  if (app) await app.close();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function overlay(): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('/text-overlay.html'))).toBe(true);
  return app.windows().find((w) => w.url().endsWith('/text-overlay.html'))!;
}

test('text window is isolated, transparent, text-only and safe for untrusted content', async () => {
  const text = await overlay();
  const geometry = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/text-overlay.html'))!;
    return { visible: window.isVisible(), top: window.isAlwaysOnTop() };
  });
  expect(geometry.top).toBe(true);
  expect(geometry.visible).toBe(false);
  expect(await text.evaluate(() => Object.keys(window.navi))).toEqual(['desktopText']);
  expect(await text.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await main.evaluate(() => window.navi.desktopText.show('<img src=x onerror=alert(1)>\n文字だけです。', 'MEMO'));
  await expect(text.locator('#text')).toContainText('<img');
  await expect(text.locator('img')).toHaveCount(0);
  expect(await text.evaluate(() => getComputedStyle(document.querySelector('#text')!).webkitTextStrokeWidth)).toBe('1px');
  await expect(text.locator('#text')).toContainText('文字だけ');
});

test('long text pages stay until closed; resize, position and click-through settings apply', async () => {
  const text = await overlay();
  await main.evaluate(() => window.navi.desktopText.show('一つ目の説明です。\n'.repeat(20) + '最後の説明です。', 'ANSWER'));
  await expect(text.locator('#page')).toContainText('1 /');
  const first = await text.locator('#text').textContent();
  await main.evaluate(() => window.navi.desktopText.command('next'));
  await expect.poll(() => text.evaluate(() => window.navi.desktopText.getState().then((s) => s.page))).toBe(1);
  await main.evaluate(() => window.navi.desktopText.command('previous'));
  await expect(text.locator('#text')).toHaveText(first!);
  await main.waitForTimeout(3200);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/text-overlay.html'))!.isVisible())).toBe(true);
  await main.evaluate(async () => {
    const s = await window.navi.settings.get();
    await window.navi.settings.set({ desktopText: { ...s.desktopText, clickThrough: false, position: 'TOP_RIGHT', fontSize: 36 } });
  });
  await expect(text.locator('body')).toHaveClass('draggable');
  await expect.poll(() => text.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('36px');
  const movedTo = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/text-overlay.html'))!;
    const bounds = w.getBounds();
    w.setPosition(bounds.x - 60, bounds.y + 50);
    return { x: bounds.x - 60, y: bounds.y + 50 };
  });
  await expect.poll(() => main.evaluate(() => window.navi.settings.get().then((s) => ({
    position: s.desktopText.position, x: s.desktopText.x, y: s.desktopText.y,
  })))).toEqual({ position: 'FREE', ...movedTo });
  await main.evaluate(() => window.navi.desktopText.command('hide'));
  await expect(text.locator('#text')).toHaveText('');
});

test('short answers expire, fixed memos survive, and an overlay failure leaves the avatar and chat up', async () => {
  let text = await overlay();
  await main.evaluate(() => window.navi.desktopText.show('短い返答です。', 'ANSWER'));
  await expect(text.locator('#text')).toHaveText('短い返答です。');
  await expect(text.locator('#text')).toHaveText('', { timeout: 7000 });
  await main.evaluate(() => window.navi.desktopText.show('残す文字です。', 'ANSWER'));
  await main.evaluate(() => window.navi.desktopText.command('fix'));
  await main.waitForTimeout(3200);
  await expect(text.locator('#text')).toHaveText('残す文字です。');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/text-overlay.html'))!.destroy();
  });
  await expect(main.locator('header .brand')).toHaveText('NAVI');
  expect(app.windows().some((w) => w.url().endsWith('/avatar.html'))).toBe(true);
  await main.evaluate(() => window.navi.desktopText.show('復帰しました。', 'MEMO'));
  text = await overlay();
  await expect(text.locator('#text')).toHaveText('復帰しました。');
});

test('progress requests use cached state and text-only routing without any speech push', async () => {
  await main.evaluate(() => {
    (window as unknown as { speechPushes: number }).speechPushes = 0;
    window.navi.friend.onEvent((p) => { if (p.type === 'speech') (window as unknown as { speechPushes: number }).speechPushes++; });
    return window.navi.friend.submitText('進捗をテキストで出して');
  });
  const text = await overlay();
  await expect(text.locator('#text')).toContainText('作業はありません');
  await expect(text.locator('#text')).toHaveAttribute('data-mode', 'TASK_STATUS');
  expect(await main.evaluate(() => (window as unknown as { speechPushes: number }).speechPushes)).toBe(0);
});

test('appearance checks over bright, dark and textured backgrounds', async ({}, info) => {
  const text = await overlay();
  await main.evaluate(() => window.navi.desktopText.show('白い文字＋黒い縁\nNAVIの文字表示を確認します。', 'MEMO'));
  await expect(text.locator('#text')).toContainText('NAVI');
  for (const [name, background] of [
    ['bright', '#ffffff'], ['dark', '#101018'], ['textured', 'repeating-linear-gradient(45deg,#fff 0px,#fff 20px,#234 20px,#234 40px)'],
  ]) {
    await text.evaluate((bg) => { document.body.style.background = bg; }, background!);
    await text.screenshot({ path: info.outputPath(`text-${name}.png`) });
  }
  await text.evaluate(() => { document.body.style.background = 'transparent'; });
});
