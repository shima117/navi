/**
 * Time-bounded in-memory frame buffer (design doc §7.3).
 * Frames live only in RAM; nothing here touches the disk.
 */
export interface BufferedFrame<TImage = Uint8Array> {
  frameId: string;
  capturedAt: number;
  sourceId: string;
  hash: string;
  change: number;
  /** Compressed JPEG/WebP bytes. */
  image: TImage;
  ocrSummary?: string;
  sceneScore?: number;
}

export class FrameRingBuffer<TImage = Uint8Array> {
  private frames: BufferedFrame<TImage>[] = [];

  constructor(private readonly windowMs = 20_000) {}

  push(frame: BufferedFrame<TImage>): void {
    this.frames.push(frame);
    this.evict(frame.capturedAt);
  }

  latest(): BufferedFrame<TImage> | undefined {
    return this.frames[this.frames.length - 1];
  }

  /** Frames captured within [now - fromMsAgo, now - toMsAgo]. */
  range(now: number, fromMsAgo: number, toMsAgo = 0): BufferedFrame<TImage>[] {
    const start = now - fromMsAgo;
    const end = now - toMsAgo;
    return this.frames.filter((f) => f.capturedAt >= start && f.capturedAt <= end);
  }

  /**
   * Pick a representative frame for "今の何？": the frame with the largest
   * change in the 2–6 s window, falling back to the newest frame. A local
   * change (high scene score, small whole-frame change) counts too.
   */
  representative(now: number, fromMsAgo = 6_000, toMsAgo = 2_000): BufferedFrame<TImage> | undefined {
    const window = this.range(now, fromMsAgo, toMsAgo);
    if (window.length === 0) return this.latest();
    const score = (f: BufferedFrame<TImage>) => Math.max(f.change, f.sceneScore ?? 0);
    return window.reduce((best, f) => (score(f) > score(best) ? f : best));
  }

  /** Attach late analysis results (OCR finishes after the frame was buffered). */
  annotate(frameId: string, patch: Pick<BufferedFrame<TImage>, 'ocrSummary'>): boolean {
    const frame = this.frames.find((f) => f.frameId === frameId);
    if (!frame) return false;
    Object.assign(frame, patch);
    return true;
  }

  /** Drop everything (share stopped or source switched). */
  clear(): void {
    this.frames = [];
  }

  get size(): number {
    return this.frames.length;
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.frames.length && this.frames[i]!.capturedAt < cutoff) i++;
    if (i > 0) this.frames.splice(0, i);
  }
}
