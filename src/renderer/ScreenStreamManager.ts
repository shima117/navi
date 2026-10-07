import { dHash, hashDistance } from '../core/screen/FrameDiff';
import { FrameRingBuffer } from '../core/screen/RingBuffer';
import type { FrameSummary } from '../core/screen/FrameSummary';

const MAX_W = 1280;
const MAX_H = 720;
const HASH_W = 64;
const HASH_H = 36;
/** Store a buffered JPEG at least this often even without change, so "今の" always has a frame. */
const KEYFRAME_MS = 2_000;

/**
 * Continuous capture of the user-selected source (design doc §7.2).
 * Frames stay in a RAM ring buffer; only metadata leaves the renderer
 * unless main explicitly asks for a frame for Vision.
 */
export class ScreenStreamManager {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly buffer = new FrameRingBuffer<Blob>(20_000);
  private readonly canvas = document.createElement('canvas');
  private readonly hashCanvas = document.createElement('canvas');
  private lastHash: string | null = null;
  private lastStoredAt = 0;
  private seq = 0;
  private sourceId: string | null = null;
  private paused = false;
  private unsubscribe: (() => void) | null = null;

  async start(sourceId: string, sourceName: string, kind: 'screen' | 'window', fps: number): Promise<MediaStream> {
    await this.stop();
    // Tell main which source to hand to getDisplayMedia, then request it.
    await window.navi.capture.start(sourceId, sourceName, kind);
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false });
    this.sourceId = sourceId;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play();

    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => void this.stop());
    this.timer = setInterval(() => void this.sample(), Math.max(100, 1000 / fps));
    this.unsubscribe = window.navi.capture.onFrameRequest((req) => void this.answer(req.requestId, req.which));
    return this.stream;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    const wasSharing = this.stream !== null;
    this.stream = null;
    this.video = null;
    this.sourceId = null;
    this.lastHash = null;
    // Switching or stopping drops the old frames so they are never mistaken for the current screen.
    this.buffer.clear();
    if (wasSharing) await window.navi.capture.stop();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.buffer.clear();
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  private async sample(): Promise<void> {
    const video = this.video;
    if (!video || this.paused || !this.sourceId || video.videoWidth === 0) return;
    const now = Date.now();

    this.hashCanvas.width = HASH_W;
    this.hashCanvas.height = HASH_H;
    const hctx = this.hashCanvas.getContext('2d', { willReadFrequently: true })!;
    hctx.drawImage(video, 0, 0, HASH_W, HASH_H);
    const hash = dHash(hctx.getImageData(0, 0, HASH_W, HASH_H).data, HASH_W, HASH_H);
    const change = this.lastHash ? hashDistance(hash, this.lastHash) : 1;
    this.lastHash = hash;

    const scale = Math.min(1, MAX_W / video.videoWidth, MAX_H / video.videoHeight);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    const frameId = `${this.sourceId}#${++this.seq}`;
    const summary: FrameSummary = { frameId, capturedAt: now, sourceId: this.sourceId, hash, change, width, height };
    window.navi.capture.sendFrameSummary(summary);

    if (change < 0.05 && now - this.lastStoredAt < KEYFRAME_MS) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.getContext('2d')!.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((r) => this.canvas.toBlob(r, 'image/jpeg', 0.8));
    if (!blob || this.sourceId !== summary.sourceId) return;
    this.lastStoredAt = now;
    this.buffer.push({ frameId, capturedAt: now, sourceId: summary.sourceId, hash, change, image: blob });
  }

  private async answer(requestId: string, which: 'latest' | 'recent'): Promise<void> {
    const frame = which === 'recent' ? this.buffer.representative(Date.now()) : this.buffer.latest();
    if (!frame || this.paused) {
      window.navi.capture.respondFrame(requestId, null);
      return;
    }
    const bytes = new Uint8Array(await frame.image.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    window.navi.capture.respondFrame(requestId, {
      frameId: frame.frameId,
      capturedAt: frame.capturedAt,
      sourceId: frame.sourceId,
      sourceName: '',
      imageBase64: btoa(binary),
    });
  }
}
