import type { NaviEvents, TimingKind } from '../events/EventBus';
import { redactExternalText } from './redact';

/**
 * Optional on-disk metrics log (setting telemetryToFile, default off).
 * One JSON object per line, rotated by size. Records are built from a fixed
 * whitelist of numeric/enum fields, so no transcript text or image can end
 * up in the file (§20); error messages are redacted like everywhere else.
 */
export type TelemetryRecord =
  | { t: number; type: 'timing'; kind: TimingKind; ms: number }
  | { t: number; type: 'error'; service: string; message: string }
  | { t: number; type: 'initiative'; speak: boolean; reason: string }
  | { t: number; type: 'resource'; mode: string; auto: boolean; reason: string }
  | { t: number; type: 'session'; event: 'started' | 'ended' };

type Loggable = 'metrics.timing' | 'metrics.error' | 'metrics.initiative' | 'resource.mode' | 'session.started' | 'session.ended';

/** Map a bus event to the record written to disk (null = not logged). */
export function toTelemetryRecord<K extends Loggable>(type: K, payload: NaviEvents[K]): TelemetryRecord | null {
  switch (type) {
    case 'metrics.timing': {
      const p = payload as NaviEvents['metrics.timing'];
      return { t: p.at, type: 'timing', kind: p.kind, ms: Math.round(p.ms) };
    }
    case 'metrics.error': {
      const p = payload as NaviEvents['metrics.error'];
      return { t: p.at, type: 'error', service: redactExternalText(p.service, 48), message: redactExternalText(p.message, 200) };
    }
    case 'metrics.initiative': {
      const p = payload as NaviEvents['metrics.initiative'];
      // Silent decisions happen every few seconds; only the rare "speak" is worth a line.
      return p.speak ? { t: p.at, type: 'initiative', speak: true, reason: redactExternalText(p.reason, 48) } : null;
    }
    case 'resource.mode': {
      const p = payload as NaviEvents['resource.mode'];
      return { t: p.at, type: 'resource', mode: p.mode, auto: p.auto, reason: redactExternalText(p.reason, 48) };
    }
    case 'session.started':
    case 'session.ended': {
      const p = payload as NaviEvents['session.started'];
      return { t: p.at, type: 'session', event: type === 'session.started' ? 'started' : 'ended' };
    }
    default:
      return null;
  }
}

/** The few filesystem calls the log needs (node:fs/promises in Electron, a fake in tests). */
export interface LogFs {
  mkdir(dir: string): Promise<void>;
  /** Size in bytes, or null if the file does not exist. */
  size(file: string): Promise<number | null>;
  append(file: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(file: string): Promise<void>;
}

export interface RotatingLogOptions {
  baseName?: string;
  /** Rotate once the current file would exceed this. */
  maxBytes?: number;
  /** Rotated files kept besides the current one (telemetry.1.jsonl … telemetry.N.jsonl). */
  keep?: number;
  join?: (dir: string, name: string) => string;
}

export class RotatingJsonlLog {
  private readonly baseName: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly join: (dir: string, name: string) => string;
  private size: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private failures = 0;

  constructor(
    private readonly fs: LogFs,
    private readonly dir: string,
    opts: RotatingLogOptions = {},
  ) {
    this.baseName = opts.baseName ?? 'telemetry';
    this.maxBytes = opts.maxBytes ?? 1_000_000;
    this.keep = Math.max(1, opts.keep ?? 3);
    this.join = opts.join ?? ((d, n) => `${d}/${n}`);
  }

  get currentFile(): string {
    return this.join(this.dir, `${this.baseName}.jsonl`);
  }

  private rotated(i: number): string {
    return this.join(this.dir, `${this.baseName}.${i}.jsonl`);
  }

  /** Queue a record. Writes are serialized; failures are logged once and never thrown (§19). */
  write(record: TelemetryRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    this.queue = this.queue.then(() => this.append(line)).catch((err) => {
      if (this.failures++ === 0) console.error('[telemetry] log write failed', err);
      this.size = null;
    });
  }

  /** Resolves when everything queued so far is on disk (or failed). */
  flush(): Promise<void> {
    return this.queue;
  }

  private async append(line: string): Promise<void> {
    const bytes = utf8Length(line);
    if (this.size === null) {
      await this.fs.mkdir(this.dir);
      this.size = (await this.fs.size(this.currentFile)) ?? 0;
    }
    if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate();
    await this.fs.append(this.currentFile, line);
    this.size += bytes;
  }

  private async rotate(): Promise<void> {
    const oldest = this.rotated(this.keep);
    if ((await this.fs.size(oldest)) !== null) await this.fs.remove(oldest);
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = this.rotated(i);
      if ((await this.fs.size(from)) !== null) await this.fs.rename(from, this.rotated(i + 1));
    }
    await this.fs.rename(this.currentFile, this.rotated(1));
    this.size = 0;
  }
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}
