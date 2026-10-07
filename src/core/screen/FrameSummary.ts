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
}
