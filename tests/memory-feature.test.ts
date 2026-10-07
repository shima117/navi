import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../electron/context';
import { DEFAULT_SETTINGS, IPC, type NaviSettings } from '../electron/ipc';
import type { SettingsStore } from '../electron/settings';
import { EventBus } from '../src/core/events/EventBus';
import type { MemoryItem, MemoryStats } from '../src/core/memory/MemoryStore';
import { T0 } from './memory-helpers';

// Fake Electron main-process API: records IPC handlers and app events.
const electron = vi.hoisted(() => ({
  userData: '',
  getPathFails: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appListeners: new Map<string, Array<(e: { preventDefault(): void }) => void>>(),
  quit: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      if (electron.getPathFails) throw new Error('no userData');
      return electron.userData;
    },
    on: (event: string, fn: (e: { preventDefault(): void }) => void) => {
      electron.appListeners.set(event, [...(electron.appListeners.get(event) ?? []), fn]);
    },
    quit: electron.quit,
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => electron.handlers.set(channel, fn),
  },
}));

function fakeSettings(patch: Partial<NaviSettings> = {}) {
  let current: NaviSettings = { ...DEFAULT_SETTINGS, ...patch };
  const listeners = new Set<(n: NaviSettings, p: NaviSettings) => void>();
  return {
    get current() {
      return current;
    },
    set(next: Partial<NaviSettings>) {
      const prev = current;
      current = { ...current, ...next };
      for (const l of listeners) l(current, prev);
    },
    onChange(l: (n: NaviSettings, p: NaviSettings) => void) {
      listeners.add(l);
      l(current, current);
      return () => listeners.delete(l);
    },
  };
}

async function boot(opts: { settings?: Partial<NaviSettings>; chat?: (req: unknown) => Promise<string> } = {}) {
  vi.resetModules();
  const mod = await import('../electron/features/memory');
  const settings = fakeSettings(opts.settings);
  const bus = new EventBus();
  const memory = mod.createMemoryStore(settings as unknown as SettingsStore);
  const ctx = {
    bus,
    settings,
    memory,
    router: { chatModel: () => ({ model: 'fake', keepAlive: '5m' }) },
    ollama: { chat: opts.chat ?? (async () => '{"facts":[]}') },
    health: { isHealthy: () => true },
  } as unknown as AppContext;
  await mod.memoryFeature.setup(ctx);
  bus.emit('session.started', { at: T0 });
  // Like ipcRenderer.invoke: a throwing handler becomes a rejected promise.
  const invoke = <T>(channel: string, ...args: unknown[]) =>
    new Promise<T>((resolve) => resolve(electron.handlers.get(channel)!({}, ...args) as T));
  return { mod, ctx, bus, settings, memory, invoke };
}

function fireWillQuit(): boolean {
  let prevented = false;
  for (const fn of electron.appListeners.get('will-quit') ?? []) fn({ preventDefault: () => (prevented = true) });
  return prevented;
}

beforeEach(() => {
  electron.userData = mkdtempSync(path.join(tmpdir(), 'navi-feature-'));
  electron.getPathFails = false;
  electron.handlers.clear();
  electron.appListeners.clear();
  electron.quit.mockReset();
});

afterEach(() => {
  rmSync(electron.userData, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('memory feature (main process)', () => {
  it('opens navi.sqlite and serves the Memory tab API', async () => {
    const { invoke, bus } = await boot({ settings: { persistMemory: true } });
    bus.emit('memory.write', { text: 'ユーザーはタルコフが好き', tier: 'long' });
    bus.emit('memory.write', { text: '今日はレイドで3回死んだ', tier: 'session' });

    const stats = await invoke<MemoryStats>(IPC.memoryStats);
    expect(stats).toMatchObject({ backend: 'sqlite', long: 1, session: 1, sessions: 1 });
    expect(stats.error).toBeUndefined();

    const all = await invoke<MemoryItem[]>(IPC.memoryList);
    expect(all).toHaveLength(2);
    expect((await invoke<MemoryItem[]>(IPC.memoryList, 'long')).map((m) => m.text)).toEqual(['ユーザーはタルコフが好き']);
    const [hit] = await invoke<MemoryItem[]>(IPC.memorySearch, 'レイド');
    expect(hit?.text).toBe('今日はレイドで3回死んだ');

    const edited = await invoke<MemoryItem | null>(IPC.memoryUpdate, hit!.id, '今日はレイドで4回死んだ');
    expect(edited?.text).toBe('今日はレイドで4回死んだ');
    expect(await invoke(IPC.memoryUpdate, 42, 'x')).toBeNull();

    await invoke(IPC.memoryDelete, hit!.id);
    expect(await invoke<MemoryItem[]>(IPC.memoryList)).toHaveLength(1);

    await invoke(IPC.memoryClear, 'all');
    expect(await invoke<MemoryItem[]>(IPC.memoryList)).toEqual([]);
    await expect(invoke(IPC.memoryClear, 'everything')).rejects.toThrow(/unknown/);
  });

  it('falls back to RAM and says why when SQLite cannot be opened (§19)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    electron.getPathFails = true;
    const { invoke, bus } = await boot();
    bus.emit('memory.write', { text: 'ユーザーはタルコフが好き', tier: 'session' });
    expect(await invoke<MemoryStats>(IPC.memoryStats)).toMatchObject({ backend: 'memory', session: 1, error: 'no userData' });
  });

  it('forgets session memories at quit and on the next start unless persistMemory is on', async () => {
    const first = await boot();
    first.bus.emit('memory.write', { text: '今日はレイドで3回死んだ', tier: 'session' });
    first.bus.emit('session.ended', { at: T0 + 1000 });
    await first.mod.memoryFeature.stop!(first.ctx);
    expect(fireWillQuit()).toBe(false);

    const second = await boot({ settings: { persistMemory: true } });
    expect(await second.invoke<MemoryItem[]>(IPC.memoryList)).toEqual([]);
    second.bus.emit('memory.write', { text: '今日はレイドで3回死んだ', tier: 'session' });
    await second.mod.memoryFeature.stop!(second.ctx);

    const third = await boot({ settings: { persistMemory: true } });
    expect((await third.invoke<MemoryItem[]>(IPC.memoryList)).map((m) => m.text)).toEqual(['今日はレイドで3回死んだ']);
    await third.mod.memoryFeature.stop!(third.ctx);
  });

  it('holds quit until the end-of-session summary is stored', async () => {
    let release!: (v: string) => void;
    const app = await boot({
      settings: { persistMemory: true },
      chat: () => new Promise<string>((r) => (release = r)),
    });
    for (const text of ['タルコフのPvPが一番楽しい', 'サイドストーリーは正直だるい']) {
      app.bus.emit('voice.transcript', { id: text, text, source: 'voice', at: T0 });
    }
    app.bus.emit('session.ended', { at: T0 + 1000 });
    await app.mod.memoryFeature.stop!(app.ctx);
    expect(fireWillQuit()).toBe(true);
    expect(electron.quit).not.toHaveBeenCalled();

    release('{"facts":["ユーザーはサイドストーリーより対人戦が好き"]}');
    await vi.waitFor(() => expect(electron.quit).toHaveBeenCalled());
    expect(fireWillQuit()).toBe(false);

    const next = await boot({ settings: { persistMemory: true } });
    const long = await next.invoke<MemoryItem[]>(IPC.memoryList, 'long');
    expect(long.map((m) => [m.text, m.source])).toEqual([['ユーザーはサイドストーリーより対人戦が好き', 'summary']]);
    await next.mod.memoryFeature.stop!(next.ctx);
  });

  it('purges old logs when the retention setting changes', async () => {
    const { invoke, bus, settings } = await boot({ settings: { persistUtterances: true } });
    bus.emit('voice.transcript', { id: 'old', text: 'ずっと前の話', source: 'text', at: Date.now() - 20 * 86_400_000 });
    bus.emit('voice.transcript', { id: 'new', text: 'さっきの話', source: 'text', at: Date.now() });
    expect((await invoke<MemoryStats>(IPC.memoryStats)).utterances).toBe(2);
    settings.set({ utteranceRetentionDays: 7 });
    expect((await invoke<MemoryStats>(IPC.memoryStats)).utterances).toBe(1);
  });
});
