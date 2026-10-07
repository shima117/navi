import { RECONNECT_SCHEDULE_MS } from '../ai/Backoff';
import { redactExternalText } from '../telemetry/redact';

/**
 * Supervision of the external helper processes the user asked NAVI to run
 * (voice service, VOICEVOX engine, `ollama serve`). Pure logic: spawning,
 * timers and health probes are injected so this runs in tests without
 * real processes. A crashing helper is restarted with the §19 backoff and
 * given up on (and reported) when it keeps crashing; it never takes the app down.
 */
export interface ProcessSpec {
  /** Stable id, e.g. 'voice-service'. */
  id: string;
  /** Shown in the Diagnostics tab. */
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  /** Extra environment on top of the app's own. */
  env?: Record<string, string>;
  /**
   * Localhost URL that answers when the service is up. If it already answers
   * before we spawn (the user started it by hand, or Ollama's tray app is
   * running), we leave it alone instead of fighting over the port.
   */
  healthUrl?: string;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** Spawn failure (e.g. ENOENT: executable not found). */
  error?: string;
}

/** What the supervisor needs from a child process. */
export interface ChildProcessLike {
  readonly pid?: number;
  /** Called exactly once, when the process is gone for any reason. */
  onExit(cb: (info: ExitInfo) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  /** Ask the process (tree) to terminate. Must not throw. */
  kill(): void;
}

/** May throw synchronously; that counts as a crash. */
export type SpawnFn = (spec: ProcessSpec) => ChildProcessLike;
export type ProbeFn = (url: string) => Promise<boolean>;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type ProcessState =
  /** Not running and not supposed to be. */
  | 'stopped'
  /** Checking whether it is already running elsewhere. */
  | 'starting'
  | 'running'
  /** Crashed; waiting to restart. */
  | 'backoff'
  /** Someone else is already serving healthUrl; we only watch. */
  | 'external'
  /** Crashed too often; given up until the user restarts it. */
  | 'failed';

export interface ProcessStatus {
  id: string;
  label: string;
  /** Command line for display. */
  commandLine: string;
  state: ProcessState;
  pid: number | null;
  startedAt: number | null;
  /** Automatic restarts since the user last (re)started it. */
  restarts: number;
  /** Crashes inside the current give-up window. */
  recentCrashes: number;
  lastExit: (ExitInfo & { at: number }) | null;
  nextRestartAt: number | null;
  /** Why it was given up on (state 'failed'). */
  failedReason: string | null;
  /** Last stderr lines, redacted (no transcripts, §20). */
  stderr: string[];
}

export interface WatchdogOptions {
  /** Restart delays; the last one repeats. Default: 1, 2, 5, 10, 30 s (§19). */
  backoffMs?: readonly number[];
  /** Give up after this many crashes inside crashWindowMs. */
  maxCrashes?: number;
  crashWindowMs?: number;
  /** A run at least this long counts as healthy again: the backoff restarts from the first step. */
  stableAfterMs?: number;
  /** How often an 'external' service is re-checked so we can take over if it dies. */
  externalPollMs?: number;
  stderrLines?: number;
  probe?: ProbeFn;
  /** Every state change. */
  onChange?: (status: ProcessStatus) => void;
  /** An unexpected exit. `gaveUp` = no further restarts. */
  onCrash?: (status: ProcessStatus, gaveUp: boolean) => void;
}

const DEFAULTS = {
  maxCrashes: 5,
  crashWindowMs: 180_000,
  stableAfterMs: 60_000,
  externalPollMs: 15_000,
  stderrLines: 30,
};

/** Keeps a partial line until its newline arrives, but never grows without bound. */
const MAX_PARTIAL_LINE = 4_096;

export function commandLine(spec: Pick<ProcessSpec, 'command' | 'args'>): string {
  return [spec.command, ...spec.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

/** One supervised helper process. */
export class SupervisedProcess {
  private state: ProcessState = 'stopped';
  /** Bumped by stop()/start(); late callbacks from an older epoch are ignored. */
  private epoch = 0;
  private child: ChildProcessLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private crashTimes: number[] = [];
  private restarts = 0;
  private pid: number | null = null;
  private startedAt: number | null = null;
  private lastExit: ProcessStatus['lastExit'] = null;
  private nextRestartAt: number | null = null;
  private failedReason: string | null = null;
  private stderr: string[] = [];
  private partial = '';
  private readonly opts: WatchdogOptions & typeof DEFAULTS & { backoffMs: readonly number[] };

  constructor(
    readonly spec: ProcessSpec,
    private readonly spawn: SpawnFn,
    private readonly clock: Clock = systemClock,
    opts: WatchdogOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts, backoffMs: opts.backoffMs ?? RECONNECT_SCHEDULE_MS };
  }

  get id(): string {
    return this.spec.id;
  }

  status(): ProcessStatus {
    return {
      id: this.spec.id,
      label: this.spec.label,
      commandLine: commandLine(this.spec),
      state: this.state,
      pid: this.pid,
      startedAt: this.startedAt,
      restarts: this.restarts,
      recentCrashes: this.crashTimes.length,
      lastExit: this.lastExit ? { ...this.lastExit } : null,
      nextRestartAt: this.nextRestartAt,
      failedReason: this.failedReason,
      stderr: [...this.stderr],
    };
  }

  /** Start (or start again after giving up). No-op while already active. */
  start(): void {
    if (this.state !== 'stopped' && this.state !== 'failed') return;
    this.attempt = 0;
    this.crashTimes = [];
    this.restarts = 0;
    this.failedReason = null;
    void this.launch(++this.epoch);
  }

  /** Intentional stop: kill the child and do not restart it. */
  stop(): void {
    this.epoch++;
    this.cancelTimer();
    const child = this.child;
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    if (child) safeKill(child);
    this.setState('stopped');
  }

  /** User-requested restart; also clears a 'failed' state. */
  restart(): void {
    this.stop();
    this.start();
  }

  private async launch(epoch: number): Promise<void> {
    this.timer = null;
    this.nextRestartAt = null;
    const { probe } = this.opts;
    if (probe && this.spec.healthUrl) {
      // Re-checks of an external service keep showing 'external' instead of flickering.
      if (this.state !== 'external') this.setState('starting');
      let alreadyUp = false;
      try {
        alreadyUp = await probe(this.spec.healthUrl);
      } catch {
        alreadyUp = false;
      }
      if (epoch !== this.epoch) return;
      if (alreadyUp) {
        if (this.state !== 'external') this.setState('external');
        this.timer = this.clock.setTimeout(() => void this.launch(epoch), this.opts.externalPollMs);
        return;
      }
    }
    this.spawnChild(epoch);
  }

  private spawnChild(epoch: number): void {
    let child: ChildProcessLike;
    try {
      child = this.spawn(this.spec);
    } catch (err) {
      this.handleExit(epoch, null, { code: null, signal: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.child = child;
    this.pid = child.pid ?? null;
    this.startedAt = this.clock.now();
    this.partial = '';
    child.onStderr((chunk) => {
      if (epoch === this.epoch && this.child === child) this.captureStderr(chunk);
    });
    child.onExit((info) => this.handleExit(epoch, child, info));
    // onExit may have fired synchronously (spawn error surfaced immediately).
    if (this.child === child) this.setState('running');
  }

  private handleExit(epoch: number, child: ChildProcessLike | null, info: ExitInfo): void {
    // Exits we caused (stop/restart) or from a replaced child are not crashes.
    if (epoch !== this.epoch || (child !== null && this.child !== child)) return;
    const now = this.clock.now();
    const ranMs = this.startedAt === null ? 0 : now - this.startedAt;
    this.flushPartial();
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.lastExit = { ...info, error: info.error === undefined ? undefined : redactExternalText(info.error), at: now };

    if (ranMs >= this.opts.stableAfterMs) this.attempt = 0;
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < this.opts.crashWindowMs), now];

    if (this.crashTimes.length >= this.opts.maxCrashes) {
      this.failedReason = `crashed ${this.crashTimes.length} times within ${Math.round(this.opts.crashWindowMs / 1000)}s`;
      this.setState('failed');
      this.opts.onCrash?.(this.status(), true);
      return;
    }

    const steps = this.opts.backoffMs;
    const delay = steps[Math.min(this.attempt, steps.length - 1)]!;
    this.attempt++;
    this.nextRestartAt = now + delay;
    this.setState('backoff');
    this.opts.onCrash?.(this.status(), false);
    this.timer = this.clock.setTimeout(() => {
      if (epoch !== this.epoch) return;
      this.restarts++;
      void this.launch(epoch);
    }, delay);
  }

  private captureStderr(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    if (this.partial.length > MAX_PARTIAL_LINE) {
      parts.push(this.partial);
      this.partial = '';
    }
    for (const line of parts) this.pushStderr(line);
  }

  private flushPartial(): void {
    if (this.partial) this.pushStderr(this.partial);
    this.partial = '';
  }

  private pushStderr(line: string): void {
    const clean = redactExternalText(line);
    if (!clean) return;
    this.stderr.push(clean);
    if (this.stderr.length > this.opts.stderrLines) this.stderr.splice(0, this.stderr.length - this.opts.stderrLines);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.nextRestartAt = null;
  }

  private setState(state: ProcessState): void {
    this.state = state;
    try {
      this.opts.onChange?.(this.status());
    } catch (err) {
      console.error('[watchdog] onChange failed', err);
    }
  }
}

function safeKill(child: ChildProcessLike): void {
  try {
    child.kill();
  } catch (err) {
    console.error('[watchdog] kill failed', err);
  }
}

/** The set of supervised processes, reconfigured from settings. */
export class ProcessWatchdog {
  private readonly procs = new Map<string, SupervisedProcess>();

  constructor(
    private readonly spawn: SpawnFn,
    private readonly clock: Clock = systemClock,
    private readonly opts: WatchdogOptions = {},
  ) {}

  /**
   * Make the running set match `specs`: unchanged specs keep running, changed
   * ones are restarted, missing ones are stopped. Nothing else is started.
   */
  configure(specs: readonly ProcessSpec[]): void {
    const wanted = new Map(specs.map((s) => [s.id, s]));
    for (const [id, proc] of this.procs) {
      const next = wanted.get(id);
      if (!next || !sameSpec(proc.spec, next)) {
        proc.stop();
        this.procs.delete(id);
      }
    }
    for (const spec of specs) {
      if (this.procs.has(spec.id)) continue;
      const proc = new SupervisedProcess(spec, this.spawn, this.clock, this.opts);
      this.procs.set(spec.id, proc);
      proc.start();
    }
  }

  /** Manual restart from the Diagnostics tab. False if the id is not configured. */
  restart(id: string): boolean {
    const proc = this.procs.get(id);
    if (!proc) return false;
    proc.restart();
    return true;
  }

  /** App quit: kill every child. Synchronous so it completes inside before-quit. */
  stopAll(): void {
    for (const proc of this.procs.values()) proc.stop();
  }

  get(id: string): ProcessStatus | null {
    return this.procs.get(id)?.status() ?? null;
  }

  list(): ProcessStatus[] {
    return [...this.procs.values()].map((p) => p.status());
  }
}

export function sameSpec(a: ProcessSpec, b: ProcessSpec): boolean {
  return JSON.stringify(normalizeSpec(a)) === JSON.stringify(normalizeSpec(b));
}

function normalizeSpec(s: ProcessSpec): unknown {
  const env = s.env ? Object.fromEntries(Object.entries(s.env).sort(([x], [y]) => x.localeCompare(y))) : {};
  return [s.id, s.label, s.command, s.args, s.cwd ?? '', env, s.healthUrl ?? ''];
}
