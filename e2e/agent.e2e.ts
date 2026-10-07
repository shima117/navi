import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from 'playwright/test';
import type {} from '../src/renderer/global';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = createRequire(import.meta.url)('electron') as unknown as string;
let app: ElectronApplication;
let main: Page;
let profile: string;

async function launch() {
  app = await electron.launch({ executablePath: BIN, args: ['.', '--no-sandbox'], cwd: ROOT,
    env: { ...process.env, NAVI_USER_DATA: profile, OPENAI_API_KEY: '' }, timeout: 30000 });
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('/index.html'))).toBe(true);
  main = app.windows().find((w) => w.url().endsWith('/index.html'))!;
  await expect(main.locator('header .brand')).toHaveText('NAVI');
  await expect.poll(() => main.evaluate(() => window.navi.tasks.agentState().then((s) => s.ready))).toBe(true);
}
test.beforeEach(async () => {
  profile = await mkdtemp(path.join(os.tmpdir(), 'navi-agent-e2e-'));
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({
    audio: { voicemeeterAutoConfigure: false, listenSystemAudio: false, listenRemoteAudio: false },
  }));
  await launch();
});
test.afterEach(async () => {
  if (app) await app.close();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('natural requests enqueue real isolated work and keep the conversation response immediate', async () => {
  const state = await main.evaluate(() => window.navi.tasks.agentState());
  expect(state.pid).not.toBe(app.process().pid);
  expect(state.pid).toBeGreaterThan(0);
  const began = Date.now();
  await main.evaluate(() => window.navi.friend.submitText('NAVIの環境を確認して'));
  await expect(main.locator('.line.navi .text').last()).toContainText('裏で進める');
  expect(Date.now() - began).toBeLessThan(1500);
  await expect.poll(() => main.evaluate(() => window.navi.tasks.list().then((t) => t.some((s) => s.lastReport)))).toBe(true);
  const task = (await main.evaluate(() => window.navi.tasks.list()))[0]!;
  expect(['DONE', 'WAITING']).toContain(task.status);
  expect(task.lastReport?.verification?.method).toBe('HTTP');
  await main.evaluate(() => window.navi.friend.submitText('今進捗どう？ テキストで見せて'));
  const overlay = app.windows().find((w) => w.url().endsWith('/text-overlay.html'))!;
  await expect(overlay.locator('#text')).toContainText('環境確認');
  expect(await main.evaluate(() => window.navi.plugin.list())).toEqual([]);
});

test('global cancel reaches queued and running tasks, and cancelled records survive restart', async () => {
  const ids = await main.evaluate(async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, () => window.navi.tasks.startHealth()));
    await window.navi.tasks.control('CANCEL');
    return ids;
  });
  await expect.poll(() => main.evaluate(() => window.navi.tasks.list().then((tasks) => tasks.filter((s) => s.status === 'CANCELLED').length))).toBeGreaterThan(0);
  await main.waitForTimeout(300);
  await app.close();
  await launch();
  const records = await main.evaluate(() => window.navi.tasks.list());
  expect(records.every((s) => ids.includes(s.id))).toBe(true);
  expect(records.some((s) => s.status === 'CANCELLED')).toBe(true);
  expect(records.some((s) => s.status === 'RUNNING' || s.status === 'PLANNING')).toBe(false);
});

test('project selection runs only a read-only manifest verifier and records evidence', async () => {
  const project = path.join(profile, 'selected-project');
  await mkdir(project);
  await writeFile(path.join(project, 'package.json'), '{"name":"fixture","scripts":{"test":"DO NOT EXECUTE"}}');
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [directory] })) as unknown as typeof dialog.showOpenDialog;
    dialog.showMessageBox = (async (_window: unknown, options: { detail?: string; defaultId?: number }) => {
      if (!options.detail?.includes(directory) || !options.detail.includes('Cloud') || options.defaultId !== 0) throw new Error('Consent disclosure missing');
      return { response: 1, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  }, project);
  const id = await main.evaluate(() => window.navi.tasks.inspectProject());
  await expect.poll(() => main.evaluate((id) => window.navi.tasks.list().then((tasks) => tasks.find((s) => s.id === id)?.status), id)).toBe('DONE');
  const record = (await main.evaluate(() => window.navi.tasks.list())).find((s) => s.id === id)!;
  expect(record.lastReport?.verified).toBe(true);
  expect(record.lastReport?.verification?.evidence).toContain('JSON object parsed');
  expect(record.lastReport?.summary).not.toContain('DO NOT EXECUTE');
  const approvals = await main.evaluate(() => window.navi.tasks.approvals());
  expect(approvals).toHaveLength(1);
  expect(approvals[0]?.state).toBe('CONSUMED');
  expect(approvals[0]?.taskId).toBe(id);
  await main.getByRole('button', { name: '作業', exact: true }).click();
  await expect(main.getByTestId('approval-history')).toBeVisible();
  const avatar = app.windows().find((w) => w.url().endsWith('/avatar.html'))!;
  expect(await avatar.evaluate(() => window.navi.tasks.approvals().then(() => 'unexpected', () => 'denied'))).toBe('denied');
  await app.close();
  await launch();
  expect((await main.evaluate(() => window.navi.tasks.approvals()))[0]?.state).toBe('REVOKED');
});

test('native consent denial does not read or create a task', async () => {
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [directory] })) as unknown as typeof dialog.showOpenDialog;
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox;
  }, profile);
  expect(await main.evaluate(() => window.navi.tasks.inspectProject())).toBeNull();
  expect(await main.evaluate(() => window.navi.tasks.list())).toEqual([]);
  expect(await main.evaluate(() => window.navi.tasks.approvals())).toEqual([]);
});

test('global cancel invalidates an open consent prompt while cached status remains available', async () => {
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [directory] })) as unknown as typeof dialog.showOpenDialog;
    dialog.showMessageBox = (() => new Promise((resolve) => {
      (globalThis as unknown as { finishConsent: () => void }).finishConsent = () => resolve({ response: 1, checkboxChecked: false });
    })) as unknown as typeof dialog.showMessageBox;
  }, profile);
  await main.evaluate(() => {
    (window as unknown as { pendingConsent: Promise<string | null> }).pendingConsent = window.navi.tasks.inspectProject();
  });
  await expect.poll(() => app.evaluate(() => typeof (globalThis as unknown as { finishConsent?: () => void }).finishConsent)).toBe('function');
  await main.evaluate(() => window.navi.friend.submitText('今どう？'));
  await expect(main.locator('.line.navi .text').last()).toContainText('作業はありません');
  await main.evaluate(() => window.navi.tasks.control('CANCEL'));
  await app.evaluate(() => (globalThis as unknown as { finishConsent: () => void }).finishConsent());
  expect(await main.evaluate(() => (window as unknown as { pendingConsent: Promise<string | null> }).pendingConsent)).toBeNull();
  expect(await main.evaluate(() => window.navi.tasks.list())).toEqual([]);
  expect(await main.evaluate(() => window.navi.tasks.approvals())).toEqual([]);
});

test('an Agent process crash does not stop the main window or avatar, and is not retried silently', async () => {
  const state = await main.evaluate(() => window.navi.tasks.agentState());
  expect(state.pid).toBeGreaterThan(0);
  const pid = state.pid!;
  expect(pid).not.toBe(app.process().pid);
  process.kill(pid, 'SIGKILL');
  await expect.poll(() => main.evaluate(() => window.navi.tasks.agentState().then((s) => s.error))).toContain('終了しました');
  await expect(main.locator('header .brand')).toHaveText('NAVI');
  const avatar = app.windows().find((w) => w.url().endsWith('/avatar.html'))!;
  // This verifies continued rendering, not a hardware-dependent frame-rate target.
  // Count actual callbacks rather than time since scheduling: the first callback
  // can be delayed by the desktop compositor even while the renderer is alive.
  // Two separate observations ensure rendering keeps advancing after the crash.
  for (let interval = 0; interval < 2; interval++) {
    const timestamps = await avatar.evaluate(() => new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Avatar frame callbacks stopped')), 5000);
      const times: number[] = [];
      function count(now: number) {
        times.push(now);
        if (times.length === 3) { clearTimeout(timer); resolve(times); }
        else requestAnimationFrame(count);
      }
      requestAnimationFrame(count);
    }));
    expect(timestamps[1]!).toBeGreaterThan(timestamps[0]!);
    expect(timestamps[2]!).toBeGreaterThan(timestamps[1]!);
  }
  await main.evaluate(() => window.navi.friend.submitText('今どう？'));
  await expect(main.locator('.line.navi .text').last()).toContainText('作業はありません');
});

test('OpenAI task UI refuses missing keys and secrets without network or task creation', async () => {
  await main.getByRole('button', { name: '作業', exact: true }).click();
  await expect(main.getByTestId('openai-task')).toBeVisible();
  await expect(main.getByTestId('openai-state')).toContainText('APIキー未設定');
  await main.getByLabel('OpenAIに送信する文章').fill('これは公開の試験用文章です。');
  await main.getByRole('button', { name: '送信内容と料金を確認', exact: true }).click();
  await expect(main.getByRole('alert')).toContainText('OPENAI_API_KEYが未設定');
  await main.screenshot({ path: test.info().outputPath('openai-task.png'), fullPage: true });
  expect(await main.evaluate(() => window.navi.tasks.list())).toEqual([]);
  const state = await main.evaluate(() => window.navi.tasks.cloudState());
  expect(state.keyConfigured).toBe(false);
  expect(state.dayChargedMicros).toBe(0);
  await main.getByLabel('OpenAIに送信する文章').fill('api_key=fixture-not-real');
  await main.getByRole('button', { name: '送信内容と料金を確認', exact: true }).click();
  await expect(main.getByRole('alert')).toContainText('秘密情報');
  expect(await main.evaluate(() => window.navi.tasks.list())).toEqual([]);
  const avatar = app.windows().find((w) => w.url().endsWith('/avatar.html'))!;
  expect(await avatar.evaluate(() => window.navi.tasks.openAiText({ text: 'public fixture', tier: 'ECONOMY', dataClass: 'PUBLIC', maxCostMicros: 250000 }).then(() => 'unexpected', () => 'denied'))).toBe('denied');
  const overlay = app.windows().find((w) => w.url().endsWith('/text-overlay.html'))!;
  expect(await overlay.evaluate(() => 'tasks' in window.navi)).toBe(false);
});
