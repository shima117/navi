import { randomUUID } from 'node:crypto';
import type { FrameProvider, VisionFrame } from '../src/core/screen/VisionService';
import { IPC } from './ipc';
import type { WindowManager } from './windows';

const FRAME_REQUEST_TIMEOUT_MS = 1_500;

/** What the user is sharing right now (main-process view). */
export interface CaptureState {
  sourceId: string | null;
  sourceName: string | null;
  kind: 'screen' | 'window';
  paused: boolean;
}

/**
 * Vision frames live in the renderer's RAM ring buffer; main asks for one on
 * demand and the renderer answers with capture:frameResponse.
 */
export class FrameBridge implements FrameProvider {
  private pending = new Map<string, (frame: VisionFrame | null) => void>();

  constructor(
    private readonly windows: WindowManager,
    private readonly capture: CaptureState,
  ) {}

  getFrame(which: 'latest' | 'recent'): Promise<VisionFrame | null> {
    if (!this.windows.main || !this.capture.sourceId || this.capture.paused) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, FRAME_REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      this.windows.sendMain(IPC.captureFrameRequest, { requestId, which });
    });
  }

  resolve(requestId: string, frame: VisionFrame | null): void {
    const done = this.pending.get(requestId);
    if (!done) return;
    this.pending.delete(requestId);
    // Never treat a frame from a previous source as the current screen.
    done(frame && frame.sourceId === this.capture.sourceId ? { ...frame, sourceName: this.capture.sourceName ?? '' } : null);
  }
}
