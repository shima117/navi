import { afterEach, describe, expect, it, vi } from 'vitest';
import { OcrRunner, type OcrEngine, type OcrResult } from '../src/renderer/ocr/OcrRunner';

/** Fake tesseract: each recognize waits until the test settles it. */
class FakeEngine implements OcrEngine {
  terminated = false;
  calls = 0;
  pending: Array<{ resolve: (r: OcrResult) => void; reject: (e: Error) => void }> = [];
  recognize(): Promise<OcrResult> {
    this.calls++;
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  terminate(): void {
    this.terminated = true;
  }
  finish(text = 'セール ¥1,980', confidence = 90): void {
    this.pending.shift()!.resolve({ text, confidence });
  }
}

const IMG = new Uint8Array([1, 2, 3]);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('OcrRunner', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates the engine lazily, once, and returns results', async () => {
    const engine = new FakeEngine();
    const factory = vi.fn(async () => engine);
    const runner = new OcrRunner(factory);
    expect(factory).not.toHaveBeenCalled();

    const p = runner.run(IMG);
    expect(runner.busy).toBe(true);
    await flush();
    engine.finish();
    expect(await p).toEqual({ text: 'セール ¥1,980', confidence: 90 });
    expect(runner.busy).toBe(false);

    const p2 = runner.run(IMG);
    await flush();
    engine.finish('2');
    expect((await p2)!.text).toBe('2');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('runs one job at a time', async () => {
    const engine = new FakeEngine();
    const runner = new OcrRunner(async () => engine);
    const p1 = runner.run(IMG);
    expect(await runner.run(IMG)).toBeNull();
    await flush();
    engine.finish();
    await p1;
    expect(engine.calls).toBe(1);
  });

  it('cancelling a stale job resolves it to null and terminates the worker', async () => {
    const engines: FakeEngine[] = [];
    const runner = new OcrRunner(async () => {
      engines.push(new FakeEngine());
      return engines[engines.length - 1]!;
    });
    const p = runner.run(IMG);
    await flush();
    runner.cancel();
    expect(await p).toBeNull();
    expect(engines[0]!.terminated).toBe(true);
    expect(runner.busy).toBe(false);
    expect(runner.disabled).toBe(false);

    // The next job gets a fresh worker.
    const p2 = runner.run(IMG);
    await flush();
    engines[1]!.finish('fresh');
    expect((await p2)!.text).toBe('fresh');
  });

  it('kills a stuck job after the timeout', async () => {
    vi.useFakeTimers();
    const engine = new FakeEngine();
    const runner = new OcrRunner(async () => engine, { jobTimeoutMs: 1_000 });
    const p = runner.run(IMG);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await p).toBeNull();
    expect(engine.terminated).toBe(true);
    expect(runner.disabled).toBe(false);
  });

  it('turns itself off when the engine cannot start (missing assets, CSP)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const factory = vi.fn(async (): Promise<OcrEngine> => {
      throw new Error('404');
    });
    const runner = new OcrRunner(factory);
    expect(await runner.run(IMG)).toBeNull();
    expect(runner.disabled).toBe(true);
    expect(await runner.run(IMG)).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);

    runner.reenable();
    expect(runner.disabled).toBe(false);
    await runner.run(IMG);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('a hanging init times out and disables OCR', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new OcrRunner(() => new Promise<OcrEngine>(() => {}), { initTimeoutMs: 5_000 });
    const p = runner.run(IMG);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await p).toBeNull();
    expect(runner.disabled).toBe(true);
  });

  it('gives up after repeated job failures, without logging any text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new FakeEngine();
    const runner = new OcrRunner(async () => engine, { maxFailures: 2 });
    for (let i = 0; i < 2; i++) {
      const p = runner.run(IMG);
      await flush();
      engine.pending.shift()!.reject(new Error('secret screen text'));
      expect(await p).toBeNull();
    }
    expect(runner.disabled).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('dispose terminates an idle worker', async () => {
    const engine = new FakeEngine();
    const runner = new OcrRunner(async () => engine);
    const p = runner.run(IMG);
    await flush();
    engine.finish();
    await p;
    runner.dispose();
    await flush();
    expect(engine.terminated).toBe(true);
  });
});
