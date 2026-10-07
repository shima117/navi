import { describe, expect, it } from 'vitest';
import {
  cellLabel,
  describeChangedRegions,
  RecentRegionChanges,
  RegionChangeTracker,
  regionChanges,
  regionSignatures,
  sceneScore,
} from '../src/core/screen/RegionHash';

const W = 128;
const H = 72;

function image(fn: (x: number, y: number) => number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      a[i] = a[i + 1] = a[i + 2] = Math.max(0, Math.min(255, fn(x, y)));
      a[i + 3] = 255;
    }
  return a;
}

/** A busy desktop: every cell has its own texture. */
const desktop = (x: number, y: number) => 60 + ((x * 37 + y * 91 + ((x * y) % 17) * 11) % 140);

/** Same desktop with a bright "tooltip" (with text-like stripes) in one area. */
const withPopup = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number) =>
  x >= x0 && x < x1 && y >= y0 && y < y1 ? (x % 4 < 2 ? 250 : 20) : desktop(x, y);

function analyze(before: Uint8ClampedArray, after: Uint8ClampedArray) {
  const t = new RegionChangeTracker();
  t.update(before, W, H);
  return t.update(after, W, H);
}

describe('RegionHash', () => {
  it('maps the 4x4 grid onto nine labels', () => {
    const labels = Array.from({ length: 16 }, (_, i) => cellLabel(i));
    expect(labels).toEqual([
      '左上', '上', '上', '右上',
      '左', '中央', '中央', '右',
      '左', '中央', '中央', '右',
      '左下', '下', '下', '右下',
    ]);
  });

  it('an unchanged frame changes nothing', () => {
    const r = analyze(image(desktop), image(desktop));
    expect(r.changes.every((c) => c === 0)).toBe(true);
    expect(r.changedRegions).toEqual([]);
    expect(r.sceneScore).toBe(0);
  });

  it.each([
    ['右下', [100, 58, 126, 70]],
    ['左上', [2, 2, 28, 16]],
    ['右', [100, 24, 126, 46]],
    ['中央', [40, 22, 88, 50]],
    ['下', [36, 58, 90, 70]],
  ] as const)('a change localized in one area is labelled %s', (label, [x0, y0, x1, y1]) => {
    const r = analyze(image(desktop), image(withPopup(x0, y0, x1, y1)));
    expect(r.changedRegions).toEqual([label]);
    expect(r.sceneScore).toBeGreaterThanOrEqual(0.15);
    expect(r.sceneScore).toBeLessThan(0.6);
    expect(Math.max(...r.changes)).toBeGreaterThanOrEqual(0.3);
  });

  it('a full scene change is 全体 with a high scene score', () => {
    const r = analyze(image(desktop), image((x, y) => 255 - desktop(x, y)));
    expect(r.changedRegions).toEqual(['全体']);
    expect(r.sceneScore).toBeGreaterThan(0.7);
  });

  it('noise on a solid background is not a change', () => {
    const flat = image(() => 200);
    const noisy = image((x, y) => 200 + ((x * 7 + y * 3) % 3) - 1);
    const r = analyze(flat, noisy);
    expect(r.changedRegions).toEqual([]);
    expect(r.sceneScore).toBeLessThan(0.1);
  });

  it('a solid area changing colour is a change', () => {
    const r = analyze(image(() => 30), image((x, y) => (x >= 96 && y >= 54 ? 220 : 30)));
    expect(r.changedRegions).toEqual(['右下']);
  });

  it('the first frame counts as fully changed', () => {
    const r = new RegionChangeTracker().update(image(desktop), W, H);
    expect(r.changedRegions).toEqual(['全体']);
    expect(r.sceneScore).toBe(1);
  });

  it('reset forgets the previous frame', () => {
    const t = new RegionChangeTracker();
    t.update(image(desktop), W, H);
    t.reset();
    expect(t.update(image(desktop), W, H).changedRegions).toEqual(['全体']);
  });

  it('several areas are listed strongest first, at most three', () => {
    const changes = new Array(16).fill(0);
    changes[15] = 0.9; // 右下
    changes[0] = 0.4; // 左上
    changes[3] = 0.6; // 右上
    changes[12] = 0.3; // 左下
    expect(describeChangedRegions(changes)).toEqual(['右下', '右上', '左上']);
    expect(sceneScore(changes)).toBeCloseTo(0.5 * 0.9 + 0.5 * (4 / 16), 1);
  });

  it('works on odd frame sizes', () => {
    const sigs = regionSignatures(new Uint8ClampedArray(7 * 5 * 4), 7, 5);
    expect(sigs).toHaveLength(16);
    expect(regionChanges(null, sigs)).toEqual(new Array(16).fill(1));
  });
});

describe('RecentRegionChanges', () => {
  const frame = (at: number, changedRegions: string[], sceneScore = 0.4, sourceId = 's1') =>
    ({ capturedAt: at, sourceId, changedRegions, sceneScore }) as Parameters<RecentRegionChanges['add']>[0];

  it('reports where the screen changed in the last few seconds', () => {
    const r = new RecentRegionChanges(5_000);
    r.add(frame(1_000, ['左上']));
    r.add(frame(9_000, ['右下']));
    r.add(frame(9_500, ['右下', '右']));
    expect(r.labels(10_000)).toEqual(['右下', '右']);
    expect(r.labels(20_000)).toEqual([]);
  });

  it('ignores flickers below the hint threshold', () => {
    const r = new RecentRegionChanges();
    r.add(frame(1_000, ['左'], 0.05));
    expect(r.labels(1_500)).toEqual([]);
  });

  it('a scene cut hides older local changes', () => {
    const r = new RecentRegionChanges();
    r.add(frame(1_000, ['左上']));
    r.add(frame(2_000, ['全体'], 0.9));
    expect(r.labels(2_500)).toEqual(['全体']);
    r.add(frame(3_000, ['右下']));
    expect(r.labels(3_500)).toEqual(['右下']);
  });

  it('a different source starts over', () => {
    const r = new RecentRegionChanges();
    r.add(frame(1_000, ['左上']));
    r.add(frame(1_200, [], 0, 's2'));
    expect(r.sourceId).toBe('s2');
    expect(r.labels(1_500)).toEqual([]);
  });
});
