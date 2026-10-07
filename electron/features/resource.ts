import { execFile } from 'node:child_process';
import { DEFAULT_MODELS } from '../../src/core/ai/ModelRouter';
import type { ResourceMode } from '../../src/core/resource/ResourceGovernor';
import { decideResourceMode, transitionActions, type ResourceReason } from '../../src/core/resource/ResourcePolicy';
import type { ResourceDiagnostics } from '../../src/core/telemetry/DiagnosticsReport';
import { NVIDIA_SMI_ARGS, parseNvidiaSmi, type VramReading } from '../../src/core/telemetry/vram';
import type { AppContext } from '../context';
import type { Feature } from './Feature';

/**
 * Resource governor automation (§4, PR-10): game → GAME_PRIORITY, sharing
 * something else → BALANCED, nothing shared → DESKTOP_CHAT; the manual
 * Settings choice when autoResourceMode is off.
 */
const POLL_MS = 1_000;
const VRAM_CACHE_MS = 5_000;
/** After nvidia-smi is found missing, do not spawn it again for a while. */
const VRAM_MISSING_RETRY_MS = 60_000;
const NVIDIA_SMI_TIMEOUT_MS = 2_000;

const state: { mode: ResourceMode | null; reason: ResourceReason; changedAt: number | null } = {
  mode: null,
  reason: 'manual',
  changedAt: null,
};
let pollTimer: ReturnType<typeof setInterval> | null = null;

function apply(ctx: AppContext): void {
  const s = ctx.settings.current;
  const d = decideResourceMode({
    auto: s.autoResourceMode,
    manualMode: s.resourceMode,
    gameActive: ctx.plugins.activePlugin !== null,
    sharing: ctx.capture.sourceId !== null,
  });
  // The settings feature also sets the manual mode on every settings change;
  // this listener runs after it, so the situational mode wins while auto is on.
  if (ctx.governor.currentMode !== d.mode) ctx.governor.setMode(d.mode);
  if (d.mode === state.mode && d.reason === state.reason) return;

  const prev = state.mode;
  const now = Date.now();
  state.mode = d.mode;
  state.reason = d.reason;
  state.changedAt = now;
  if (prev !== d.mode && transitionActions(prev, d.mode).unloadLargeVision) {
    // Hand the large vision model's VRAM back to the game now, not after its keep-alive.
    void ctx.ollama.unload(DEFAULT_MODELS.visionLarge);
  }
  ctx.bus.emit('resource.mode', { mode: d.mode, auto: s.autoResourceMode, reason: d.reason, at: now });
}

export function resourceDiagnostics(ctx: AppContext, vram: VramReading | null): ResourceDiagnostics {
  const s = ctx.settings.current;
  return {
    mode: ctx.governor.currentMode,
    auto: s.autoResourceMode,
    manualMode: s.resourceMode,
    reason: state.reason,
    changedAt: state.changedAt,
    vram,
  };
}

export const resourceFeature: Feature = {
  name: 'resource',
  setup(ctx) {
    ctx.settings.onChange(() => apply(ctx));
  },
  start(ctx) {
    // Share and plugin changes have no bus event; polling two fields is cheap and decoupled.
    pollTimer = setInterval(() => apply(ctx), POLL_MS);
  },
  stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  },
};

let vramCache: { at: number; value: VramReading | null } | null = null;
let vramMissingAt: number | null = null;
let vramInflight: Promise<VramReading | null> | null = null;

/** VRAM via nvidia-smi; null when there is no NVIDIA GPU or tool. Never throws. */
export function readVram(): Promise<VramReading | null> {
  const now = Date.now();
  if (vramCache && now - vramCache.at < VRAM_CACHE_MS) return Promise.resolve(vramCache.value);
  if (vramMissingAt !== null && now - vramMissingAt < VRAM_MISSING_RETRY_MS) return Promise.resolve(null);
  vramInflight ??= new Promise<VramReading | null>((resolve) => {
    try {
      execFile('nvidia-smi', [...NVIDIA_SMI_ARGS], { timeout: NVIDIA_SMI_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        const value = err ? null : parseNvidiaSmi(String(stdout));
        if (err) vramMissingAt = Date.now();
        vramCache = { at: Date.now(), value };
        resolve(value);
      });
    } catch {
      vramMissingAt = Date.now();
      resolve(null);
    }
  }).finally(() => {
    vramInflight = null;
  });
  return vramInflight;
}
