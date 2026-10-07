import type { EventBus, TimingKind } from '../events/EventBus';
import { redactExternalText } from './redact';

/**
 * Local-only runtime metrics (PR-10). Everything stays in RAM in the main
 * process; nothing here is sent anywhere. Only numbers, reasons and service
 * names are kept — never transcript text or images (§20).
 */
export const TIMING_KINDS: readonly TimingKind[] = ['response', 'chat', 'vision', 'tts'];

/** §23.3: react to the user's voice within ~2 s. */
export const RESPONSE_TARGET_MS = 2_000;

/** Fixed-capacity FIFO of numbers; the oldest sample falls out first. */
export class SampleRing {
  private readonly buf: number[] = [];
  private total = 0;

  constructor(readonly capacity: number) {}

  push(value: number): void {
    this.buf.push(value);
    if (this.buf.length > this.capacity) this.buf.shift();
    this.total++;
  }

  values(): number[] {
    return [...this.buf];
  }

  /** Samples ever recorded (the ring only holds the latest `capacity`). */
  get count(): number {
    return this.total;
  }
}

/** Nearest-rank percentile of an ascending-sorted array (p in 0..100). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

export interface LatencyStats {
  /** Samples ever recorded. */
  count: number;
  /** Samples the percentiles are computed over (latest N). */
  window: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  last: number | null;
}

export interface ErrorEntry {
  service: string;
  message: string;
  at: number;
}

export interface MetricsSnapshot {
  latency: Record<TimingKind, LatencyStats>;
  initiative: { speak: number; silent: number; byReason: Record<string, number> };
  errors: { byService: Record<string, number>; recent: ErrorEntry[] };
}

export interface MetricsOptions {
  /** Latency samples kept per kind. */
  samples?: number;
  /** Recent errors kept for the Diagnostics tab. */
  recentErrors?: number;
}

export class Metrics {
  private readonly timings = new Map<TimingKind, SampleRing>();
  private readonly lastTiming = new Map<TimingKind, number>();
  private readonly initiativeByReason = new Map<string, number>();
  private initiativeSpeak = 0;
  private initiativeSilent = 0;
  private readonly errorsByService = new Map<string, number>();
  private readonly recent: ErrorEntry[] = [];
  private readonly maxRecent: number;

  constructor(opts: MetricsOptions = {}) {
    const samples = opts.samples ?? 200;
    this.maxRecent = opts.recentErrors ?? 50;
    for (const k of TIMING_KINDS) this.timings.set(k, new SampleRing(samples));
  }

  recordTiming(kind: TimingKind, ms: number): void {
    // Clock jumps (sleep/resume, NTP) can produce nonsense; drop it rather than skew p95.
    if (!Number.isFinite(ms) || ms < 0 || ms > 10 * 60_000) return;
    this.timings.get(kind)?.push(Math.round(ms));
    this.lastTiming.set(kind, Math.round(ms));
  }

  recordError(service: string, message: string, at: number): void {
    const entry = { service: redactExternalText(service, 48), message: redactExternalText(message, 200), at };
    this.errorsByService.set(entry.service, (this.errorsByService.get(entry.service) ?? 0) + 1);
    this.recent.push(entry);
    if (this.recent.length > this.maxRecent) this.recent.shift();
  }

  recordInitiative(speak: boolean, reason: string): void {
    if (speak) this.initiativeSpeak++;
    else this.initiativeSilent++;
    const key = speak ? 'speak' : reason;
    this.initiativeByReason.set(key, (this.initiativeByReason.get(key) ?? 0) + 1);
  }

  latency(kind: TimingKind): LatencyStats {
    const ring = this.timings.get(kind)!;
    const sorted = ring.values().sort((a, b) => a - b);
    return {
      count: ring.count,
      window: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted.length ? sorted[sorted.length - 1]! : null,
      last: this.lastTiming.get(kind) ?? null,
    };
  }

  snapshot(): MetricsSnapshot {
    const latency = Object.fromEntries(TIMING_KINDS.map((k) => [k, this.latency(k)])) as Record<TimingKind, LatencyStats>;
    return {
      latency,
      initiative: {
        speak: this.initiativeSpeak,
        silent: this.initiativeSilent,
        byReason: Object.fromEntries(this.initiativeByReason),
      },
      errors: {
        byService: Object.fromEntries(this.errorsByService),
        recent: this.recent.map((e) => ({ ...e })),
      },
    };
  }
}

/**
 * Feed Metrics from the bus. A service going offline counts as an error for
 * that service; recovering does not. Returns an unsubscribe function.
 */
export function attachMetrics(bus: EventBus, metrics: Metrics, now: () => number = Date.now): () => void {
  const offs = [
    bus.on('metrics.timing', (t) => metrics.recordTiming(t.kind, t.ms)),
    bus.on('metrics.error', (e) => metrics.recordError(e.service, e.message, e.at)),
    bus.on('metrics.initiative', (d) => metrics.recordInitiative(d.speak, d.reason)),
    bus.on('health.changed', (h) => {
      if (!h.ok) metrics.recordError(h.service, 'offline', now());
    }),
  ];
  return () => offs.forEach((off) => off());
}
