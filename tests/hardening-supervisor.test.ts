import { describe, expect, it } from 'vitest';
import {
  ProcessWatchdog,
  SupervisedProcess,
  type ChildProcessLike,
  type Clock,
  type ExitInfo,
  type ProcessSpec,
  type ProcessStatus,
  type WatchdogOptions,
} from '../src/core/supervisor/ProcessWatchdog';
import {
  buildProcessSpecs,
  configProblem,
  DEFAULT_MANAGED_PROCESSES,
  dirnameOf,
  normalizeManagedProcesses,
  splitArgs,
} from '../src/core/supervisor/processSpecs';

class FakeClock implements Clock {
  t = 0;
  private seq = 0;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
  get pending(): number {
    return this.timers.length;
  }
  /** Advance virtual time, firing due timers in order and letting async work settle. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = due.at;
      due.fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

const settle = () => new Promise<void>((r) => setImmediate(r));

class FakeChild implements ChildProcessLike {
  killed = false;
  private exitCb: ((info: ExitInfo) => void) | null = null;
  private stderrCb: ((chunk: string) => void) | null = null;
  private done = false;
  constructor(readonly pid: number) {}
  onExit(cb: (info: ExitInfo) => void): void {
    this.exitCb = cb;
  }
  onStderr(cb: (chunk: string) => void): void {
    this.stderrCb = cb;
  }
  kill(): void {
    this.killed = true;
    this.exit({ code: null, signal: 'SIGTERM' });
  }
  exit(info: ExitInfo = { code: 1, signal: null }): void {
    if (this.done) return;
    this.done = true;
    this.exitCb?.(info);
  }
  stderr(text: string): void {
    this.stderrCb?.(text);
  }
}

function harness(opts: WatchdogOptions & { throwOnSpawn?: boolean } = {}) {
  const clock = new FakeClock();
  const children: FakeChild[] = [];
  const crashes: Array<{ status: ProcessStatus; gaveUp: boolean }> = [];
  let pid = 100;
  let throwOnSpawn = opts.throwOnSpawn ?? false;
  const spawn = (_spec: ProcessSpec): ChildProcessLike => {
    if (throwOnSpawn) throw new Error('spawn python ENOENT');
    const c = new FakeChild(++pid);
    children.push(c);
    return c;
  };
  const options: WatchdogOptions = { ...opts, onCrash: (status, gaveUp) => crashes.push({ status, gaveUp }) };
  return {
    clock,
    children,
    crashes,
    spawn,
    options,
    last: () => children[children.length - 1]!,
    setThrow: (v: boolean) => (throwOnSpawn = v),
  };
}

const spec = (over: Partial<ProcessSpec> = {}): ProcessSpec => ({
  id: 'voice-service',
  label: 'voice',
  command: 'python',
  args: ['-m', 'navi_voice.server'],
  ...over,
});

describe('SupervisedProcess', () => {
  it('starts once and reports running', async () => {
    const h = harness();
    const p = new SupervisedProcess(spec(), h.spawn, h.clock, h.options);
    p.start();
    p.start();
    await settle();
    expect(h.children).toHaveLength(1);
    expect(p.status()).toMatchObject({ state: 'running', pid: 101, restarts: 0 });
    expect(p.status().commandLine).toBe('python -m navi_voice.server');
  });

  it('restarts an unexpected exit with the 1, 2, 5, 10, 30 s backoff', async () => {
    const h = harness({ maxCrashes: 100 });
    const p = new SupervisedProcess(spec(), h.spawn, h.clock, h.options);
    p.start();
    await settle();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      h.last().exit({ code: 1, signal: null });
      const st = p.status();
      expect(st.state).toBe('backoff');
      const delay = st.nextRestartAt! - h.clock.now();
      delays.push(delay);
      await h.clock.advance(delay - 1);
      expect(h.children).toHaveLength(i + 1);
      await h.clock.advance(1);
      expect(h.children).toHaveLength(i + 2);
      expect(p.status().state).toBe('running');
    }
    expect(delays).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 30_000]);
    expect(p.status().restarts).toBe(6);
    expect(h.crashes.every((c) => !c.gaveUp)).toBe(true);
  });

  it('gives up after N crashes inside the window and reports it', async () => {
    const h = harness({ maxCrashes: 3, crashWindowMs: 60_000 });
    const p = new SupervisedProcess(spec(), h.spawn, h.clock, h.options);
    p.start();
    await settle();
    h.last().exit();
    await h.clock.advance(1_000);
    h.last().exit();
    await h.clock.advance(2_000);
    h.last().exit({ code: 3, signal: null });

    const st = p.status();
    expect(st.state).toBe('failed');
    expect(st.failedReason).toContain('3 times');
    expect(st.lastExit).toMatchObject({ code: 3 });
    expect(h.crashes.map((c) => c.gaveUp)).toEqual([false, false, true]);
    await h.clock.advance(10 * 60_000);
    expect(h.children).toHaveLength(3);
    expect(h.clock.pending).toBe(0);

    // The user's restart button clears the failure and tries again.
    p.restart();
    await settle();
    expect(h.children).toHaveLength(4);
    expect(p.status()).toMatchObject({ state: 'running', recentCrashes: 0, failedReason: null });
  });

  it('does not give up on crashes spread beyond the window, and a stable run resets the backoff', async () => {
    const h = harness({ maxCrashes: 3, crashWindowMs: 60_000, stableAfterMs: 30_000 });
    const p = new SupervisedProcess(spec(), h.spawn, h.clock, h.options);
    p.start();
    await settle();
    for (let i = 0; i < 5; i++) {
      await h.clock.advance(40_000); // runs long enough to count as healthy
      h.last().exit();
      expect(p.status().state).toBe('backoff');
      expect(p.status().nextRestartAt! - h.clock.now()).toBe(1_000);
      await h.clock.advance(1_000);
    }
    expect(p.status().state).toBe('running');
    expect(h.crashes.some((c) => c.gaveUp)).toBe(false);
  });

  it('an intentional stop kills the child and never restarts it', async () => {
    const h = harness();
    const p = new SupervisedProcess(spec(), h.spawn, h.clock, h.options);
    p.start();
    await settle();
    const child = h.last();
    p.stop();
    expect(child.killed).toBe(true);
    expect(p.status().state).toBe('stopped');
    await h.clock.advance(120_000);
    expect(h.children).toHaveLength(1);
    expect(h.crashes).toHaveLength(0);
  });

  it('stopping during backoff cancels the pending restart', async () => {
    const h = harness();
    const p = new SupervisedProcess(spec(), h.spawn, h.clock, h.options);
    p.start();
    await settle();
    h.last().exit();
    p.stop();
    await h.clock.advance(60_000);
    expect(h.children).toHaveLength(1);
    expect(p.status().state).toBe('stopped');
  });

  it('keeps the last stderr lines, joined across chunks and redacted', async () => {
    const h = harness({ stderrLines: 3 });
    const p = new SupervisedProcess(spec(), h.spawn, h.clock, h.options);
    p.start();
    await settle();
    const c = h.last();
    c.stderr('INFO: line one\nINFO: li');
    c.stderr('ne two\r\n\nINFO: transcript=今日は仕事だるかった ok\n');
    c.stderr('Traceback: boom\nfinal partial');
    c.exit({ code: 1, signal: null });
    // Oldest dropped (limit 3); CJK replaced; the unterminated last line kept on exit.
    expect(p.status().stderr).toEqual(['INFO: transcript=… ok', 'Traceback: boom', 'final partial']);
  });

  it('a spawn that throws (executable not found) counts as a crash', async () => {
    const h = harness({ throwOnSpawn: true, maxCrashes: 2 });
    const p = new SupervisedProcess(spec(), h.spawn, h.clock, h.options);
    p.start();
    await settle();
    expect(p.status().state).toBe('backoff');
    expect(p.status().lastExit?.error).toContain('ENOENT');
    await h.clock.advance(1_000);
    expect(p.status().state).toBe('failed');
    expect(h.crashes.map((c) => c.gaveUp)).toEqual([false, true]);
  });

  it('leaves an already-running service alone and takes over when it goes away', async () => {
    let externalUp = true;
    const probed: string[] = [];
    const h = harness({
      externalPollMs: 10_000,
      probe: async (url) => {
        probed.push(url);
        return externalUp;
      },
    });
    const p = new SupervisedProcess(spec({ healthUrl: 'http://127.0.0.1:17650/health' }), h.spawn, h.clock, h.options);
    p.start();
    await settle();
    expect(p.status().state).toBe('external');
    expect(h.children).toHaveLength(0);
    await h.clock.advance(10_000);
    expect(p.status().state).toBe('external');
    externalUp = false;
    await h.clock.advance(10_000);
    expect(h.children).toHaveLength(1);
    expect(p.status().state).toBe('running');
    expect(probed.every((u) => u === 'http://127.0.0.1:17650/health')).toBe(true);
  });

  it('ignores a late exit from a child replaced by a manual restart', async () => {
    const h = harness();
    const p = new SupervisedProcess(spec(), h.spawn, h.clock, h.options);
    p.start();
    await settle();
    const first = h.last();
    p.restart();
    await settle();
    first.exit({ code: 1, signal: null });
    expect(p.status().state).toBe('running');
    expect(h.crashes).toHaveLength(0);
  });
});

describe('ProcessWatchdog', () => {
  it('starts only what is configured and follows configuration changes', async () => {
    const h = harness();
    const wd = new ProcessWatchdog(h.spawn, h.clock, h.options);
    wd.configure([]);
    expect(h.children).toHaveLength(0);

    wd.configure([spec(), spec({ id: 'ollama', command: 'ollama', args: ['serve'] })]);
    await settle();
    expect(h.children).toHaveLength(2);
    const [voice, ollama] = h.children;

    // Same specs: nothing restarts.
    wd.configure([spec(), spec({ id: 'ollama', command: 'ollama', args: ['serve'] })]);
    await settle();
    expect(h.children).toHaveLength(2);

    // Changed voice spec restarts it; dropping ollama stops it.
    wd.configure([spec({ command: 'C:\\venv\\python.exe' })]);
    await settle();
    expect(voice!.killed).toBe(true);
    expect(ollama!.killed).toBe(true);
    expect(h.children).toHaveLength(3);
    expect(wd.list().map((s) => [s.id, s.state])).toEqual([['voice-service', 'running']]);
    expect(wd.get('ollama')).toBeNull();
  });

  it('restart() by id and stopAll() on quit', async () => {
    const h = harness();
    const wd = new ProcessWatchdog(h.spawn, h.clock, h.options);
    wd.configure([spec()]);
    await settle();
    expect(wd.restart('nope')).toBe(false);
    expect(wd.restart('voice-service')).toBe(true);
    await settle();
    expect(h.children).toHaveLength(2);
    wd.stopAll();
    expect(h.children.every((c) => c.killed)).toBe(true);
    await h.clock.advance(60_000);
    expect(h.children).toHaveLength(2);
  });
});

describe('managed process specs', () => {
  const ctx = { defaultVoiceServiceCwd: '/app/voice-service' };

  it('starts nothing by default', () => {
    expect(buildProcessSpecs(DEFAULT_MANAGED_PROCESSES, ctx)).toEqual([]);
    expect(buildProcessSpecs(normalizeManagedProcesses(undefined), ctx)).toEqual([]);
  });

  it('voice service defaults to `python -m navi_voice.server` in the bundled folder', () => {
    const cfg = normalizeManagedProcesses({ voiceService: { enabled: true } });
    const [s] = buildProcessSpecs(cfg, ctx);
    expect(s).toMatchObject({
      id: 'voice-service',
      command: 'python',
      args: ['-m', 'navi_voice.server'],
      cwd: '/app/voice-service',
      healthUrl: 'http://127.0.0.1:17650/health',
    });
    expect(s!.env).toMatchObject({ PYTHONIOENCODING: 'utf-8' });
  });

  it('uses the configured python and cwd, stripping "Copy as path" quotes', () => {
    const cfg = normalizeManagedProcesses({
      voiceService: { enabled: true, python: ' "C:\\navi\\.venv\\Scripts\\python.exe" ', cwd: '"D:\\voice"' },
    });
    expect(buildProcessSpecs(cfg, ctx)[0]).toMatchObject({ command: 'C:\\navi\\.venv\\Scripts\\python.exe', cwd: 'D:\\voice' });
  });

  it('VOICEVOX needs an executable; it runs from its own folder on 127.0.0.1', () => {
    const missing = normalizeManagedProcesses({ voicevox: { enabled: true } });
    expect(buildProcessSpecs(missing, ctx)).toEqual([]);
    expect(configProblem(missing, 'voicevox')).toBeTruthy();

    const cfg = normalizeManagedProcesses({ voicevox: { enabled: true, executable: 'C:\\Program Files\\VOICEVOX\\vv-engine\\run.exe' } });
    expect(configProblem(cfg, 'voicevox')).toBeNull();
    expect(buildProcessSpecs(cfg, ctx)[0]).toMatchObject({
      id: 'voicevox',
      command: 'C:\\Program Files\\VOICEVOX\\vv-engine\\run.exe',
      args: ['--host', '127.0.0.1', '--port', '50021'],
      cwd: 'C:\\Program Files\\VOICEVOX\\vv-engine',
    });
  });

  it('ollama serve is pinned to localhost', () => {
    const cfg = normalizeManagedProcesses({ ollama: { enabled: true, executable: '' } });
    expect(buildProcessSpecs(cfg, ctx)[0]).toMatchObject({
      id: 'ollama',
      command: 'ollama',
      args: ['serve'],
      env: { OLLAMA_HOST: '127.0.0.1:11434' },
    });
  });

  it('normalizes partial or mistyped settings', () => {
    const cfg = normalizeManagedProcesses({ voiceService: { enabled: 'yes', python: 3 }, ollama: null, extra: 1 });
    expect(cfg).toEqual(DEFAULT_MANAGED_PROCESSES);
  });

  it('splits arguments with quotes, without a shell', () => {
    expect(splitArgs('--host 127.0.0.1  --dir "C:\\My Engine" --x \'a b\' ""')).toEqual([
      '--host',
      '127.0.0.1',
      '--dir',
      'C:\\My Engine',
      '--x',
      'a b',
      '',
    ]);
    expect(splitArgs('   ')).toEqual([]);
  });

  it('dirnameOf handles Windows and POSIX paths', () => {
    expect(dirnameOf('C:\\a\\run.exe')).toBe('C:\\a');
    expect(dirnameOf('C:\\run.exe')).toBe('C:\\');
    expect(dirnameOf('/opt/vv/run')).toBe('/opt/vv');
    expect(dirnameOf('/run')).toBe('/');
    expect(dirnameOf('run.exe')).toBeUndefined();
  });
});
