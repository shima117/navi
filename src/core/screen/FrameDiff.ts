/**
 * Perceptual difference hashing (dHash). Cheap enough to run on every sampled
 * frame so the Vision model is only woken up for real changes (design doc §7.2).
 */

/** Compute a 64-bit dHash from RGBA pixels. Returns 16 hex chars. */
export function dHash(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): string {
  // Downsample to 9x8 grayscale with box averaging.
  const gw = 9;
  const gh = 8;
  const gray = new Float64Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor((gy * height) / gh);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / gh));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * width) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / gw));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const i = (y * width + x) * 4;
          sum += 0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!;
          n++;
        }
      }
      gray[gy * gw + gx] = n ? sum / n : 0;
    }
  }
  let hex = '';
  for (let gy = 0; gy < gh; gy++) {
    let byte = 0;
    for (let gx = 0; gx < 8; gx++) {
      byte = (byte << 1) | (gray[gy * gw + gx]! > gray[gy * gw + gx + 1]! ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Normalized Hamming distance between two hex hashes of equal length (0..1). */
export function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) return 1;
  let bits = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits / (a.length * 4);
}

export type ChangeLevel = 'none' | 'low' | 'high';

export function classifyChange(change: number, highThreshold = 0.25, lowThreshold = 0.05): ChangeLevel {
  if (change >= highThreshold) return 'high';
  if (change >= lowThreshold) return 'low';
  return 'none';
}
