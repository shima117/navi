import { app } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  ProcessWatchdog,
  type ChildProcessLike,
  type ExitInfo,
  type ProcessSpec,
  type ProcessStatus,
} from '../../src/core/supervisor/ProcessWatchdog';
import {
  buildProcessSpecs,
  configProblem,
  MANAGED_PROCESS_IDS,
  normalizeManagedProcesses,
  PROCESS_LABELS,
} from '../../src/core/supervisor/processSpecs';
import type { ManagedProcessEntry } from '../../src/core/telemetry/DiagnosticsReport';
import type { AppContext } from '../context';
import type { Feature } from './Feature';

/** SIGTERM first; anything still alive after this gets SIGKILL (POSIX). */
const KILL_GRACE_MS = 3_000;
const PROBE_TIMEOUT_MS = 1_500;
/** Longest wait for stderr to drain after the process exits. */
const STDERR_DRAIN_MS = 500;

let watchdog: ProcessWatchdog | null = null;
let unsubscribe: (() => void) | null = null;

/** Rows for the Diagnostics tab: every known helper, configured or not. */
export function managedProcessEntries(ctx: AppContext): ManagedProcessEntry[] {
  const cfg = normalizeManagedProcesses(ctx.settings.current.managedProcesses);
  const enabled = { 'voice-service': cfg.voiceService.enabled, voicevox: cfg.voicevox.enabled, ollama: cfg.ollama.enabled };
  return MANAGED_PROCESS_IDS.map((id) => ({
    id,
    label: PROCESS_LABELS[id],
    enabled: enabled[id],
    problem: configProblem(cfg, id),
    status: watchdog?.get(id) ?? null,
  }));
}

export function restartManagedProcess(id: string): boolean {
  return watchdog?.restart(id) ?? false;
}

/**
 * Starts and supervises the helper processes the user enabled (PR-10):
 * restart with backoff, give up and report when one keeps crashing, kill
 * them all on quit. Nothing is started unless configured.
 */
export const watchdogFeature: Feature = {
  name: 'watchdog',
  setup(ctx) {
    watchdog = new ProcessWatchdog(spawnChild, undefined, {
      probe: probeLocal,
      onCrash: (status, gaveUp) => reportCrash(ctx, status, gaveUp),
    });
    // Safety net if the app exits without before-quit (signals, crashes in main): no orphaned helpers.
    process.once('exit', () => watchdog?.stopAll());
  },
  start(ctx) {
    const defaultVoiceServiceCwd = path.join(app.getAppPath(), 'voice-service');
    let lastSpecs = '';
    // onChange fires immediately with the current settings, then on every change.
    unsubscribe = ctx.settings.onChange((next) => {
      const specs = buildProcessSpecs(normalizeManagedProcesses(next.managedProcesses), {
        defaultVoiceServiceCwd,
        voiceServiceUserData: app.getPath('userData'),
      });
      const key = JSON.stringify(specs);
      if (key === lastSpecs) return;
      lastSpecs = key;
      watchdog?.configure(specs);
    });
  },
  stop() {
    unsubscribe?.();
    unsubscribe = null;
    watchdog?.stopAll();
  },
};

function reportCrash(ctx: AppContext, status: ProcessStatus, gaveUp: boolean): void {
  const exit = status.lastExit;
  const how = exit?.error ? `spawn failed: ${exit.error}` : `exited (code ${exit?.code ?? 'null'}, signal ${exit?.signal ?? 'none'})`;
  const message = gaveUp ? `gave up: ${status.failedReason ?? 'too many crashes'}; last ${how}` : `${how}; restarting`;
  console.error(`[watchdog] ${status.id} ${message}`);
  ctx.bus.emit('metrics.error', { service: `process:${status.id}`, message, at: Date.now() });
}

/** Is something already answering on the helper's localhost URL? */
async function probeLocal(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
}

/** node:child_process adapter. No shell: arguments are passed verbatim. */
function spawnChild(spec: ProcessSpec): ChildProcessLike {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd || undefined,
    env: { ...process.env, ...spec.env },
    // stdout is never read (it could carry anything); stderr feeds diagnostics after redaction.
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  const exitListeners: Array<(info: ExitInfo) => void> = [];
  let exited: ExitInfo | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (info: ExitInfo) => {
    if (drainTimer) clearTimeout(drainTimer);
    if (exited) return;
    exited = info;
    for (const l of exitListeners) l(info);
  };
  const alive = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  // 'exit' can arrive before the last stderr chunk (the crash traceback). 'close' comes once the
  // pipe is drained; cap the wait in case a grandchild keeps the pipe open.
  child.once('exit', (code, signal) => {
    drainTimer = setTimeout(() => finish({ code, signal }), STDERR_DRAIN_MS);
  });
  child.once('close', (code, signal) => finish({ code, signal }));
  child.on('error', (err) => {
    // Without a pid the process never started (ENOENT, EACCES, bad cwd): that is its exit.
    if (child.pid === undefined) finish({ code: null, signal: null, error: err.message });
    else console.error(`[watchdog] ${spec.id} process error`, err);
  });
  child.stderr?.setEncoding('utf8');

  return {
    pid: child.pid,
    onExit(cb) {
      if (exited) cb(exited);
      else exitListeners.push(cb);
    },
    onStderr(cb) {
      child.stderr?.on('data', (chunk: string) => cb(chunk));
    },
    kill() {
      if (!alive()) return;
      try {
        if (process.platform === 'win32') {
          // Kill the whole tree: `ollama serve` and the engines start their own workers.
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (alive()) child.kill('SIGKILL');
          }, KILL_GRACE_MS).unref();
        }
      } catch (err) {
        console.error(`[watchdog] failed to kill ${spec.id}`, err);
      }
    },
  };
}
