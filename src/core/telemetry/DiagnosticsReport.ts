import type { ServiceName } from '../events/EventBus';
import type { ResourceMode } from '../resource/ResourceGovernor';
import type { ResourceReason } from '../resource/ResourcePolicy';
import type { ProcessStatus } from '../supervisor/ProcessWatchdog';
import type { ManagedProcessId } from '../supervisor/processSpecs';
import type { MetricsSnapshot } from './Metrics';
import type { VramReading } from './vram';

/**
 * What the Diagnostics tab shows and「診断情報を書き出す」saves. Built only
 * from health flags, process states, numbers and redacted error lines: it
 * never contains transcripts, memories, the user's name or images (§20).
 */
export interface ServiceHealthEntry {
  name: ServiceName;
  /** null = not probed yet. */
  ok: boolean | null;
  /** When it last flipped (null = never reported). */
  changedAt: number | null;
}

export interface ManagedProcessEntry {
  id: ManagedProcessId;
  label: string;
  enabled: boolean;
  /** Configuration problem that keeps it from starting. */
  problem: string | null;
  /** null when it is not supervised (disabled or misconfigured). */
  status: ProcessStatus | null;
}

export interface ResourceDiagnostics {
  /** Effective mode the governor runs in. */
  mode: ResourceMode;
  auto: boolean;
  /** The Settings choice, used when auto is off. */
  manualMode: ResourceMode;
  reason: ResourceReason;
  changedAt: number | null;
  /** null = no NVIDIA GPU / nvidia-smi not available. */
  vram: VramReading | null;
}

export interface DiagnosticsSnapshot {
  format: 'navi-diagnostics';
  version: 1;
  generatedAt: number;
  app: { version: string; electron: string; chrome: string; node: string; platform: string; arch: string };
  services: ServiceHealthEntry[];
  processes: ManagedProcessEntry[];
  metrics: MetricsSnapshot;
  /** §23.3 target for the response latency. */
  responseTargetMs: number;
  resource: ResourceDiagnostics;
  telemetry: { toFile: boolean; logDir: string | null };
}

export interface DiagnosticsExportResult {
  saved: boolean;
  path: string | null;
  error?: string;
}

export const DIAGNOSTIC_SERVICES: readonly ServiceName[] = ['chat', 'vision', 'stt', 'tts'];

/** Health flags plus the time each one last changed (HealthMonitor only keeps the flag). */
export class HealthTimeline {
  private readonly entries = new Map<ServiceName, { ok: boolean; changedAt: number }>();

  record(service: ServiceName, ok: boolean, at: number): void {
    const prev = this.entries.get(service);
    if (prev && prev.ok === ok) return;
    this.entries.set(service, { ok, changedAt: at });
  }

  list(services: readonly ServiceName[] = DIAGNOSTIC_SERVICES): ServiceHealthEntry[] {
    return services.map((name) => {
      const e = this.entries.get(name);
      return { name, ok: e?.ok ?? null, changedAt: e?.changedAt ?? null };
    });
  }
}

/** navi-diagnostics-20261007-153000.json (local time). */
export function diagnosticsFileName(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `navi-diagnostics-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}
