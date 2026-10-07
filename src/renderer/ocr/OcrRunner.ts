/**
 * Runs one OCR job at a time on a lazily created engine (tesseract.js in a
 * Web Worker). Every failure just turns OCR off — the rest of NAVI never
 * notices (§19). No DOM here, so it is unit-tested with a fake engine.
 */
export interface OcrResult {
  text: string;
  /** Tesseract mean confidence 0..100. */
  confidence: number;
}

export interface OcrEngine {
  recognize(image: Uint8Array): Promise<OcrResult>;
  /** Stops the worker. The only way to abort a running tesseract job. */
  terminate(): void;
}

export type OcrEngineFactory = () => Promise<OcrEngine>;

export interface OcrRunnerOptions {
  /** Loading WASM + jpn/eng data; a hang here means OCR is unusable. */
  initTimeoutMs?: number;
  /** A stuck job is killed together with its worker. */
  jobTimeoutMs?: number;
  /** Consecutive job failures before OCR gives up for this session. */
  maxFailures?: number;
}

const CANCELLED = Symbol('cancelled');
const TIMED_OUT = Symbol('timedOut');

interface Job {
  cancelled: Promise<typeof CANCELLED>;
  cancel(): void;
}

function newJob(): Job {
  let cancel!: () => void;
  const cancelled = new Promise<typeof CANCELLED>((resolve) => (cancel = () => resolve(CANCELLED)));
  return { cancelled, cancel };
}

function timeout(ms: number): { promise: Promise<typeof TIMED_OUT>; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)));
  return { promise, clear: () => clearTimeout(timer) };
}

export class OcrRunner {
  private engine: Promise<OcrEngine> | null = null;
  private job: Job | null = null;
  private failures = 0;
  private off = false;
  private readonly initTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly maxFailures: number;

  constructor(
    private readonly factory: OcrEngineFactory,
    opts: OcrRunnerOptions = {},
  ) {
    this.initTimeoutMs = opts.initTimeoutMs ?? 60_000;
    this.jobTimeoutMs = opts.jobTimeoutMs ?? 15_000;
    this.maxFailures = opts.maxFailures ?? 3;
  }

  get busy(): boolean {
    return this.job !== null;
  }

  /** OCR turned itself off after a failure (missing assets, CSP, crashes). */
  get disabled(): boolean {
    return this.off;
  }

  /** The user switched OCR back on: give it another chance. */
  reenable(): void {
    this.off = false;
    this.failures = 0;
  }

  /** OCR one image. Resolves null when busy, cancelled, failed or disabled — never rejects. */
  async run(image: Uint8Array): Promise<OcrResult | null> {
    if (this.off || this.job) return null;
    const job = newJob();
    this.job = job;
    try {
      const engine = await this.ensureEngine(job);
      if (!engine) return null;
      const limit = timeout(this.jobTimeoutMs);
      const result = await Promise.race([engine.recognize(image), job.cancelled, limit.promise]).finally(limit.clear);
      if (result === CANCELLED) return null;
      if (result === TIMED_OUT) {
        this.dropEngine();
        this.noteFailure();
        return null;
      }
      this.failures = 0;
      return result;
    } catch {
      // The message may echo engine internals; nothing about the screen is logged (§20).
      this.dropEngine();
      this.noteFailure();
      return null;
    } finally {
      if (this.job === job) this.job = null;
    }
  }

  /** Abandon the running job (stale frame). Its worker is terminated to free the CPU. */
  cancel(): void {
    const job = this.job;
    if (!job) return;
    this.job = null;
    job.cancel();
    this.dropEngine();
  }

  /** Release the worker (share ended / OCR switched off). */
  dispose(): void {
    this.cancel();
    this.dropEngine();
  }

  private async ensureEngine(job: Job): Promise<OcrEngine | null> {
    if (!this.engine) {
      const created = this.factory();
      created.catch(() => {});
      this.engine = created;
    }
    const pending = this.engine;
    const limit = timeout(this.initTimeoutMs);
    try {
      const engine = await Promise.race([pending, job.cancelled, limit.promise]);
      if (engine === CANCELLED) return null;
      if (engine === TIMED_OUT) throw new Error('OCR init timed out');
      return engine;
    } catch {
      // Could not even start (assets missing, WASM blocked): OCR stays off until re-enabled.
      if (this.engine === pending) this.dropEngine();
      this.off = true;
      console.warn('[ocr] unavailable; screen OCR disabled');
      return null;
    } finally {
      limit.clear();
    }
  }

  private dropEngine(): void {
    const engine = this.engine;
    this.engine = null;
    void engine?.then((e) => e.terminate()).catch(() => {});
  }

  private noteFailure(): void {
    if (++this.failures >= this.maxFailures) {
      this.off = true;
      console.warn('[ocr] repeated failures; screen OCR disabled');
    }
  }
}
