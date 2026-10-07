import type { RegionLabel } from './RegionHash';

/** Lightweight per-frame metadata. Never contains raw pixels so it can cross IPC cheaply. */
export interface FrameSummary {
  frameId: string;
  capturedAt: number;
  sourceId: string;
  /** 64-bit dHash as 16 hex chars. */
  hash: string;
  /** 0..1 change versus the previous frame (normalized Hamming distance). */
  change: number;
  width: number;
  height: number;
  /** Where the frame changed versus the previous one (4x4 region hash → 左上…右下 / 全体). */
  changedRegions?: RegionLabel[];
  /** 0..1 strength × extent of the change (§7.3 scene score). */
  sceneScore?: number;
}
