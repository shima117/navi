import { describe, expect, it } from 'vitest';
import { OcrGate, ocrConfigFrom, ocrIntervalMs, type OcrConfig, type OcrFrameInfo } from '../src/renderer/ocr/OcrGate';
import { ocrCropRect, ocrOutputSize, rgbaToPgm } from '../src/renderer/ocr/ocrImage';

const cfg = (over: Partial<OcrConfig> = {}): OcrConfig => ({
  enabled: true,
  mode: 'BALANCED',
  allowInGamePriority: false,
  ...over,
});

const cells = (changed: Record<number, number> = {}) => Array.from({ length: 16 }, (_, i) => changed[i] ?? 0);
const high = (at: number, changed: Record<number, number> = { 0: 1, 5: 1, 10: 1, 15: 1 }): OcrFrameInfo => ({
  at,
  change: 0.5,
  cellChanges: cells(changed),
});
const calm = (at: number): OcrFrameInfo => ({ at, change: 0, cellChanges: cells() });
const busy = (at: number): OcrFrameInfo => ({ at, change: 0.3, cellChanges: cells({ 3: 0.4 }) });

function gate(c: OcrConfig = cfg()): OcrGate {
  const g = new OcrGate();
  g.configure(c);
  return g;
}

describe('ocrIntervalMs (resource mode throttle)', () => {
  it('follows the resource mode', () => {
    expect(ocrIntervalMs(cfg({ mode: 'BALANCED' }))).toBe(3_000);
    expect(ocrIntervalMs(cfg({ mode: 'DESKTOP_CHAT' }))).toBe(1_500);
  });

  it('GAME_PRIORITY is off unless re-enabled', () => {
    expect(ocrIntervalMs(cfg({ mode: 'GAME_PRIORITY' }))).toBeNull();
    expect(ocrIntervalMs(cfg({ mode: 'GAME_PRIORITY', allowInGamePriority: true }))).toBeGreaterThanOrEqual(3_000);
  });

  it('the setting switches it off everywhere', () => {
    expect(ocrIntervalMs(cfg({ enabled: false, mode: 'DESKTOP_CHAT' }))).toBeNull();
  });

  it('maps pushed settings, defaulting missing fields', () => {
    expect(ocrConfigFrom({ ocrEnabled: false, ocrInGamePriority: true, resourceMode: 'GAME_PRIORITY' })).toEqual({
      enabled: false,
      mode: 'GAME_PRIORITY',
      allowInGamePriority: true,
    });
    expect(ocrConfigFrom({})).toEqual(cfg());
  });
});

describe('OcrGate', () => {
  it('does nothing until settings have been applied', () => {
    const g = new OcrGate();
    expect(g.enabled).toBe(false);
    g.offer(high(0), false);
    expect(g.offer(calm(250), false)).toBeNull();
  });

  it('never runs on a static screen', () => {
    const g = gate();
    for (let t = 0; t < 30_000; t += 250) expect(g.offer(calm(t), false)).toBeNull();
  });

  it('runs once the screen settles after a high change', () => {
    const g = gate();
    expect(g.offer(high(1_000), false)).toBeNull(); // mid-transition
    const t = g.offer(calm(1_250), false);
    expect(t).not.toBeNull();
    expect(t!.cells).toEqual([0, 5, 10, 15]);
    expect(g.offer(calm(1_500), false)).toBeNull(); // nothing new
  });

  it('a strong local change (one cell) triggers too, and is cropped to that cell', () => {
    const g = gate();
    expect(g.offer({ at: 0, change: 0.06, cellChanges: cells({ 15: 0.45 }) }, false)).toBeNull();
    expect(g.offer(calm(250), false)!.cells).toEqual([15]);
  });

  it('respects the per-mode interval (BALANCED ≤ 1 per 3 s, DESKTOP_CHAT ≤ 1 per 1.5 s)', () => {
    for (const [mode, gap] of [
      ['BALANCED', 3_000],
      ['DESKTOP_CHAT', 1_500],
    ] as const) {
      const g = gate(cfg({ mode }));
      const runs: number[] = [];
      // A slideshow: a new screen every 500 ms, settled in between.
      for (let t = 0; t < 12_000; t += 250) {
        const f = t % 500 === 0 ? high(t) : calm(t);
        if (g.offer(f, false)) runs.push(t);
      }
      expect(runs.length).toBeGreaterThan(2);
      for (let i = 1; i < runs.length; i++) expect(runs[i]! - runs[i - 1]!).toBeGreaterThanOrEqual(gap);
    }
  });

  it('is off in GAME_PRIORITY and when disabled', () => {
    for (const c of [cfg({ mode: 'GAME_PRIORITY' }), cfg({ enabled: false })]) {
      const g = gate(c);
      expect(g.enabled).toBe(false);
      g.offer(high(0), false);
      expect(g.offer(calm(250), false)).toBeNull();
    }
    const g = gate(cfg({ mode: 'GAME_PRIORITY', allowInGamePriority: true }));
    g.offer(high(0), false);
    expect(g.offer(calm(250), false)).not.toBeNull();
  });

  it('waits while a job is running, then reads the newest settled frame', () => {
    const g = gate();
    g.offer(high(0), false);
    expect(g.offer(calm(250), true)).toBeNull();
    expect(g.offer(calm(500), false)).not.toBeNull();
  });

  it('a screen that never settles is read at most every interval, backing off', () => {
    const g = gate(cfg({ mode: 'DESKTOP_CHAT' }));
    const runs: number[] = [];
    for (let t = 0; t < 60_000; t += 250) if (g.offer(busy(t), false)) runs.push(t);
    expect(runs[0]).toBe(1_500); // waited for a settle that never came
    const gaps = runs.slice(1).map((t, i) => t - runs[i]!);
    expect(gaps[0]).toBeGreaterThanOrEqual(3_000);
    expect(Math.max(...gaps)).toBe(6_000); // 1.5 s × 4
  });

  it('reset forgets a pending change', () => {
    const g = gate();
    g.offer(high(0), false);
    g.reset();
    expect(g.offer(calm(250), false)).toBeNull();
  });
});

describe('ocrImage', () => {
  it('reads the whole frame for big or unknown changes', () => {
    expect(ocrCropRect([], 1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(ocrCropRect([0, 3, 12, 15], 1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('crops to the changed cells with half a cell of margin', () => {
    // Bottom-right cell of a 1920x1080 frame (cells are 480x270).
    expect(ocrCropRect([15], 1920, 1080)).toEqual({ x: 1200, y: 675, width: 720, height: 405 });
    // Top-left cell, clamped at the frame edge.
    expect(ocrCropRect([0], 1920, 1080)).toEqual({ x: 0, y: 0, width: 720, height: 405 });
    // Two cells side by side in the middle row.
    expect(ocrCropRect([5, 6], 1280, 720)).toEqual({ x: 160, y: 90, width: 960, height: 360 });
  });

  it('downscales full frames to ≤1280x720 and enlarges small crops up to 2x', () => {
    expect(ocrOutputSize({ width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
    expect(ocrOutputSize({ width: 2560, height: 1440 })).toEqual({ width: 1280, height: 720 });
    expect(ocrOutputSize({ width: 400, height: 200 })).toEqual({ width: 800, height: 400 });
    expect(ocrOutputSize({ width: 1200, height: 300 })).toEqual({ width: 1280, height: 320 });
  });

  it('writes a binary PGM with BT.601 luma', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
    const pgm = rgbaToPgm(rgba, 3, 1);
    const header = 'P5\n3 1\n255\n';
    expect(new TextDecoder().decode(pgm.subarray(0, header.length))).toBe(header);
    expect([...pgm.subarray(header.length)]).toEqual([255, 0, 76]);
  });
});
