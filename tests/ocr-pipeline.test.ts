import { describe, expect, it, vi } from 'vitest';
import { OcrPipeline, type OcrFrameRef } from '../src/renderer/ocr/OcrPipeline';
import type { OcrEngine, OcrResult } from '../src/renderer/ocr/OcrRunner';
import type { OcrFrameInfo } from '../src/renderer/ocr/OcrGate';

const video = { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
const flush = () => new Promise((r) => setTimeout(r, 0));
const cells = (changed: Record<number, number>) => Array.from({ length: 16 }, (_, i) => changed[i] ?? 0);
const highInfo = (at: number): OcrFrameInfo => ({ at, change: 0.6, cellChanges: cells({ 0: 1, 15: 1, 5: 1, 10: 1 }) });
const calmInfo = (at: number): OcrFrameInfo => ({ at, change: 0, cellChanges: cells({}) });
const ref = (at: number, sourceId = 's1'): OcrFrameRef => ({ frameId: `${sourceId}#${at}`, sourceId, capturedAt: at });

function setup(results: OcrResult[]) {
  const pending: Array<(r: OcrResult) => void> = [];
  const engine: OcrEngine = {
    recognize: () => new Promise((resolve) => pending.push(resolve)),
    terminate: vi.fn(),
  };
  const sent: Array<{ frame: OcrFrameRef; text: string }> = [];
  const grab = vi.fn(() => new Uint8Array([0]));
  const p = new OcrPipeline((frame, text) => sent.push({ frame, text }), { factory: async () => engine, grab });
  p.configure({ enabled: true, mode: 'DESKTOP_CHAT', allowInGamePriority: false });
  /** A screen change followed by a settled frame at `at`: starts an OCR job. */
  const change = (at: number, sourceId = 's1') => {
    p.offer(video, ref(at - 250, sourceId), highInfo(at - 250));
    return p.offer(video, ref(at, sourceId), calmInfo(at));
  };
  const finish = async () => {
    await flush();
    pending.shift()!(results.shift()!);
    await flush();
  };
  return { p, sent, grab, change, finish, engine };
}

describe('OcrPipeline', () => {
  it('OCRs the settled frame and sends a short cleaned summary', async () => {
    const { sent, change, finish, grab } = setup([{ text: 'ショ ッ プ\n税込 \\1,980\n|', confidence: 80 }]);
    expect(change(1_000)).toBe(true);
    expect(grab).toHaveBeenCalledWith(video, [0, 5, 10, 15]);
    await finish();
    expect(sent).toEqual([{ frame: ref(1_000), text: '税込 \\1,980 / ショップ' }]);
  });

  it('drops a result that arrives after the share was paused / switched', async () => {
    const { p, sent, change, finish, engine } = setup([
      { text: '¥1,980 (old screen)', confidence: 80 },
      { text: '¥500', confidence: 80 },
    ]);
    change(1_000);
    await flush();
    p.reset({ dispose: false });
    await flush();
    expect(engine.terminate).toHaveBeenCalled(); // the stale job's worker is stopped
    await finish(); // …and even if its result still arrives, it is ignored
    expect(sent).toEqual([]);

    // The next screen is read normally.
    expect(change(5_000)).toBe(true);
    await finish();
    expect(sent.map((s) => s.text)).toEqual(['¥500']);
  });

  it('ignores low-confidence garbage and does not resend the same text', async () => {
    const { sent, change, finish } = setup([
      { text: 'ノイズ', confidence: 10 },
      { text: 'セール', confidence: 80 },
      { text: 'セール', confidence: 80 },
    ]);
    change(1_000);
    await finish();
    change(4_000);
    await finish();
    change(8_000);
    await finish();
    expect(sent.map((s) => s.text)).toEqual(['セール']);
  });

  it('does nothing while OCR is switched off, and frees the worker', async () => {
    const { p, change, grab } = setup([]);
    p.configure({ enabled: true, mode: 'GAME_PRIORITY', allowInGamePriority: false });
    expect(change(1_000)).toBe(false);
    expect(grab).not.toHaveBeenCalled();
  });
});
