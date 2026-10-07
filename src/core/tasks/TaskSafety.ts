import { checkCapability } from './PolicyEngine';

/** Non-LLM safety controls; used before every worker attempt. */
export class FailureBudget {
  attempts = 0;
  private last = '';
  private same = 0;
  private pausedAt: number | null = null;
  constructor(private start: number, readonly maxAttempts = 3, readonly maxSameError = 2, readonly maxWallClockMs = 30000) {}
  canAttempt(now: number): boolean { return this.attempts < this.maxAttempts && this.same < this.maxSameError && (this.pausedAt ?? now) - this.start < this.maxWallClockMs; }
  remainingMs(now: number): number { return Math.max(1, this.maxWallClockMs - (now - this.start)); }
  begin(now: number): void {
    if (!this.canAttempt(now)) throw new Error('Failure budget exhausted');
    this.attempts++;
  }
  failed(signature: string): void {
    this.same = signature === this.last ? this.same + 1 : 1;
    this.last = signature;
  }
  restore(attempts: number, last = '', same = 0): void { this.attempts = attempts; this.last = last; this.same = same; }
  pause(now: number): void { this.pausedAt ??= now; }
  resume(now: number): void {
    if (this.pausedAt !== null) this.start += now - this.pausedAt;
    this.pausedAt = null;
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;
  constructor(private readonly threshold = 2, private readonly cooldownMs = 30000) {}
  enter(now: number): boolean {
    if (this.openedAt === null) return true;
    if (now - this.openedAt < this.cooldownMs || this.probing) return false;
    this.probing = true;
    return true;
  }
  success(): void { this.failures = 0; this.openedAt = null; this.probing = false; }
  releaseProbe(): void { this.probing = false; }
  failure(now: number): void {
    this.probing = false;
    if (++this.failures >= this.threshold) this.openedAt = now;
  }
  get state(): 'CLOSED' | 'OPEN' | 'HALF_OPEN' {
    return this.openedAt === null ? 'CLOSED' : this.probing ? 'HALF_OPEN' : 'OPEN';
  }
}

export class ResourceLock {
  private owners = new Map<string, string>();
  acquire(owner: string, keys: string[]): (() => void) | null {
    if (keys.some((key) => this.owners.has(key) && this.owners.get(key) !== owner)) return null;
    for (const key of keys) this.owners.set(key, owner);
    return () => { for (const key of keys) if (this.owners.get(key) === owner) this.owners.delete(key); };
  }
}

/** No general shell, install, cloud, self-update or input automation entry point. */
export function checkTaskPolicy(kind: unknown): void {
  checkCapability(kind);
}
