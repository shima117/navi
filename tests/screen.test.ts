import { describe, expect, it } from 'vitest';
import { classifyChange, dHash, hashDistance } from '../src/core/screen/FrameDiff';
import { FrameRingBuffer } from '../src/core/screen/RingBuffer';
import { detectScreenReference } from '../src/core/screen/ScreenReference';

function image(w: number, h: number, fn: (x: number, y: number) => number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = fn(x, y);
      const i = (y * w + x) * 4;
      a[i] = a[i + 1] = a[i + 2] = v;
      a[i + 3] = 255;
    }
  return a;
}

describe('FrameDiff', () => {
  it('identical frames hash identically', () => {
    const img = image(64, 36, (x) => x * 4);
    expect(hashDistance(dHash(img, 64, 36), dHash(img, 64, 36))).toBe(0);
  });

  it('a very different frame has a large distance', () => {
    const a = image(64, 36, (x) => x * 4);
    const b = image(64, 36, (x) => 255 - x * 4);
    const d = hashDistance(dHash(a, 64, 36), dHash(b, 64, 36));
    expect(d).toBeGreaterThan(0.5);
    expect(classifyChange(d)).toBe('high');
  });

  it('hash is 16 hex chars', () => {
    expect(dHash(image(10, 10, () => 0), 10, 10)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('FrameRingBuffer', () => {
  const frame = (t: number, change = 0) => ({ frameId: `f${t}`, capturedAt: t, sourceId: 's', hash: '', change, image: new Uint8Array() });

  it('evicts frames older than the window', () => {
    const buf = new FrameRingBuffer(20_000);
    buf.push(frame(0));
    buf.push(frame(10_000));
    buf.push(frame(25_000));
    expect(buf.size).toBe(2);
    expect(buf.latest()?.capturedAt).toBe(25_000);
  });

  it('picks the most-changed frame from 2-6 s ago for "今の"', () => {
    const buf = new FrameRingBuffer();
    buf.push(frame(1_000, 0.1));
    buf.push(frame(5_000, 0.8));
    buf.push(frame(6_000, 0.2));
    buf.push(frame(9_500, 0.9));
    expect(buf.representative(10_000)?.capturedAt).toBe(5_000);
  });

  it('falls back to the latest frame', () => {
    const buf = new FrameRingBuffer();
    buf.push(frame(9_900));
    expect(buf.representative(10_000)?.capturedAt).toBe(9_900);
  });
});

describe('detectScreenReference', () => {
  it.each([
    ['これどう思う？', 'current'],
    ['右のやつ高くない？', 'current'],
    ['これいる？', 'current'],
    ['今の何？', 'recent'],
    ['さっきの見た？', 'recent'],
    ['今日仕事だるかった', 'none'],
    ['お腹すいた', 'none'],
  ])('%s → %s', (text, expected) => {
    expect(detectScreenReference(text)).toBe(expected);
  });
});
