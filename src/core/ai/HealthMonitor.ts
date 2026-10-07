import type { EventBus, ServiceName } from '../events/EventBus';
import { backoffDelay } from './Backoff';

export type Probe = () => Promise<boolean>;

/**
 * Polls each service and reports health changes on the bus. A down service
 * is retried with the §19 backoff schedule; a failure is never fatal.
 */
export class HealthMonitor {
  private state = new Map<ServiceName, boolean>();
  private attempts = new Map<ServiceName, number>();
  private timers = new Map<ServiceName, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(
    private readonly bus: EventBus,
    private readonly probes: Partial<Record<ServiceName, Probe>>,
    private readonly healthyIntervalMs = 15_000,
  ) {}

  start(): void {
    this.stopped = false;
    for (const name of Object.keys(this.probes) as ServiceName[]) void this.check(name);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  isHealthy(name: ServiceName): boolean {
    return this.state.get(name) ?? false;
  }

  /** Let callers report a failure seen in normal traffic so we react before the next poll. */
  reportFailure(name: ServiceName): void {
    this.set(name, false);
  }

  snapshot(): Partial<Record<ServiceName, boolean>> {
    return Object.fromEntries(this.state) as Partial<Record<ServiceName, boolean>>;
  }

  private async check(name: ServiceName): Promise<void> {
    if (this.stopped) return;
    const probe = this.probes[name]!;
    let ok = false;
    try {
      ok = await probe();
    } catch {
      ok = false;
    }
    if (this.stopped) return;
    this.set(name, ok);
    const attempt = ok ? 0 : (this.attempts.get(name) ?? 0);
    this.attempts.set(name, ok ? 0 : attempt + 1);
    const delay = ok ? this.healthyIntervalMs : backoffDelay(attempt);
    this.timers.set(name, setTimeout(() => void this.check(name), delay));
  }

  private set(name: ServiceName, ok: boolean): void {
    if (this.state.get(name) === ok) return;
    this.state.set(name, ok);
    this.bus.emit('health.changed', { service: name, ok });
  }
}
