/**
 * Where on the screen something changed (design doc §7.2 "FrameDiff + region hash").
 * Each sampled frame is split into a 4x4 grid and every cell is dHashed, so a
 * tooltip popping up in a corner is visible even when the whole-frame hash
 * barely moves. The changed area becomes a human label ("右下") that helps
 * Vision resolve 「右の」「これ」 (§7.4).
 */
import { dHash, hashDistance } from './FrameDiff';

export const REGION_GRID = 4;

export type RegionLabel = '左上' | '上' | '右上' | '左' | '中央' | '右' | '左下' | '下' | '右下' | '全体';

export interface RegionSignature {
  hash: string;
  /** Mean luma 0..255. */
  mean: number;
  /** Luma standard deviation; near 0 for a solid background. */
  spread: number;
}

export interface RegionAnalysis {
  /** Per-cell change 0..1, row-major. */
  changes: number[];
  sceneScore: number;
  changedRegions: RegionLabel[];
}

/** A cell counts as changed at or above this distance. */
export const REGION_CHANGED = 0.2;
/** Below this luma spread a cell is "flat" and its dHash bits are just noise. */
const FLAT_SPREAD = 3;
/** This share of cells changing means the whole scene changed. */
const WHOLE_SCREEN_SHARE = 0.75;
const MAX_LABELS = 3;

const luma = (rgba: ArrayLike<number>, i: number) => 0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!;

/** dHash + brightness stats for each grid cell (row-major). */
export function regionSignatures(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  grid = REGION_GRID,
): RegionSignature[] {
  const out: RegionSignature[] = [];
  for (let gy = 0; gy < grid; gy++) {
    const y0 = Math.floor((gy * height) / grid);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / grid));
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * width) / grid);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / grid));
      const w = Math.min(x1, width) - x0;
      const h = Math.min(y1, height) - y0;
      // Copy the cell out so FrameDiff.dHash can be reused unchanged.
      const cell = new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4);
      let sum = 0;
      let sumSq = 0;
      for (let y = 0; y < h; y++) {
        const src = ((y0 + y) * width + x0) * 4;
        cell.set(rgba.subarray(src, src + w * 4), y * w * 4);
        for (let x = 0; x < w; x++) {
          const v = luma(rgba, src + x * 4);
          sum += v;
          sumSq += v * v;
        }
      }
      const n = Math.max(1, w * h);
      const mean = sum / n;
      out.push({
        hash: w > 0 && h > 0 ? dHash(cell, w, h) : '0'.repeat(16),
        mean,
        spread: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
      });
    }
  }
  return out;
}

/** 0..1 change between the same cell in two frames. */
export function regionChange(a: RegionSignature, b: RegionSignature): number {
  const brightness = Math.min(1, Math.abs(a.mean - b.mean) / 64);
  // A solid area has no stable gradient: compare brightness only, or noise reads as change.
  if (a.spread < FLAT_SPREAD && b.spread < FLAT_SPREAD) return brightness;
  return Math.max(hashDistance(a.hash, b.hash), brightness);
}

/** Per-cell change; with no comparable previous frame everything counts as changed. */
export function regionChanges(prev: readonly RegionSignature[] | null, next: readonly RegionSignature[]): number[] {
  if (!prev || prev.length !== next.length) return next.map(() => 1);
  return next.map((sig, i) => regionChange(prev[i]!, sig));
}

export function changedCells(changes: readonly number[], threshold = REGION_CHANGED): number[] {
  const cells: number[] = [];
  changes.forEach((c, i) => {
    if (c >= threshold) cells.push(i);
  });
  return cells;
}

/** 4x4 → 3x3 human labels: outer rows/columns are 上/下/左/右, the middle 2x2 is 中央. */
export function cellLabel(index: number, grid = REGION_GRID): Exclude<RegionLabel, '全体'> {
  const row = Math.floor(index / grid);
  const col = index % grid;
  const v = row === 0 ? '上' : row === grid - 1 ? '下' : '';
  const h = col === 0 ? '左' : col === grid - 1 ? '右' : '';
  return ((h + v) || '中央') as Exclude<RegionLabel, '全体'>;
}

/** Labels for the changed area, strongest first; ['全体'] for a scene cut. */
export function describeChangedRegions(changes: readonly number[], threshold = REGION_CHANGED): RegionLabel[] {
  const cells = changedCells(changes, threshold);
  if (cells.length === 0) return [];
  if (cells.length >= changes.length * WHOLE_SCREEN_SHARE) return ['全体'];
  const grid = Math.round(Math.sqrt(changes.length));
  const strength = new Map<RegionLabel, number>();
  for (const i of cells) {
    const label = cellLabel(i, grid);
    strength.set(label, Math.max(strength.get(label) ?? 0, changes[i]!));
  }
  return [...strength.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LABELS)
    .map(([label]) => label);
}

/**
 * 0..1 "how much happened" (§7.3 scene score): half how strong the biggest
 * local change is, half how much of the screen it covers. A tooltip in one
 * corner scores ~0.3, a full scene cut ~0.8+, a static screen ~0.
 */
export function sceneScore(changes: readonly number[], threshold = REGION_CHANGED): number {
  if (changes.length === 0) return 0;
  const coverage = changedCells(changes, threshold).length / changes.length;
  const peak = Math.max(...changes);
  return Math.round(Math.min(1, 0.5 * peak + 0.5 * coverage) * 100) / 100;
}

/** Keeps the previous frame's cell signatures (one per shared source). */
export class RegionChangeTracker {
  private prev: RegionSignature[] | null = null;

  constructor(private readonly grid = REGION_GRID) {}

  update(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): RegionAnalysis {
    const next = regionSignatures(rgba, width, height, this.grid);
    const changes = regionChanges(this.prev, next);
    this.prev = next;
    return { changes, sceneScore: sceneScore(changes), changedRegions: describeChangedRegions(changes) };
  }

  /** Share stopped / switched / paused: the next frame is compared against nothing. */
  reset(): void {
    this.prev = null;
  }
}

/** Minimal frame metadata RecentRegionChanges needs (a FrameSummary fits). */
export interface RegionFrame {
  capturedAt: number;
  sourceId: string;
  changedRegions?: readonly RegionLabel[];
  sceneScore?: number;
}

/** Ignore tiny flickers when building hints. */
const MIN_HINT_SCORE = 0.15;

/**
 * Remembers where the screen changed in the last few seconds, for the Vision
 * hint 「変化した領域: 右下」. A full scene change makes earlier local changes
 * irrelevant, so only changes since the last 全体 are reported.
 */
export class RecentRegionChanges {
  private entries: Array<{ at: number; labels: readonly RegionLabel[]; score: number }> = [];
  private source: string | null = null;

  constructor(private readonly windowMs = 5_000) {}

  get sourceId(): string | null {
    return this.source;
  }

  add(f: RegionFrame): void {
    if (f.sourceId !== this.source) {
      this.entries = [];
      this.source = f.sourceId;
    }
    const score = f.sceneScore ?? 0;
    if (!f.changedRegions?.length || score < MIN_HINT_SCORE) return;
    this.entries.push({ at: f.capturedAt, labels: f.changedRegions, score });
    const cutoff = f.capturedAt - this.windowMs * 2;
    this.entries = this.entries.filter((e) => e.at >= cutoff).slice(-64);
  }

  labels(now: number, max = MAX_LABELS): RegionLabel[] {
    let recent = this.entries.filter((e) => now - e.at <= this.windowMs && e.at <= now);
    const lastWhole = recent.map((e) => e.labels.includes('全体')).lastIndexOf(true);
    if (lastWhole >= 0) {
      const after = recent.slice(lastWhole + 1);
      if (after.length === 0) return ['全体'];
      recent = after;
    }
    const weight = new Map<RegionLabel, number>();
    for (const e of recent) for (const l of e.labels) weight.set(l, (weight.get(l) ?? 0) + e.score);
    return [...weight.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([l]) => l);
  }

  clear(): void {
    this.entries = [];
    this.source = null;
  }
}
