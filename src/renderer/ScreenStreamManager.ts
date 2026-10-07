import { dHash, hashDistance } from '../core/screen/FrameDiff';
import { FrameRingBuffer } from '../core/screen/RingBuffer';
import type { FrameSummary } from '../core/screen/FrameSummary';
import { RegionChangeTracker } from '../core/screen/RegionHash';
import { ocrConfigFrom } from './ocr/OcrGate';
import { OcrPipeline, type OcrFrameRef } from './ocr/OcrPipeline';

const MAX_W = 1280;
const MAX_H = 720;
/** Hash input: 4x4 region cells of 32x18 px each (the whole-frame dHash box-averages it anyway). */
const HASH_W = 128;
const HASH_H = 72;
/** Store a buffered JPEG at least this often even without change, so "今の" always has a frame. */
const KEYFRAME_MS = 2_000;
/** A local change this strong is worth keeping even when the whole-frame hash barely moved. */
const STORE_SCENE_SCORE = 0.15;

/**
 * Continuous capture of the user-selected source (design doc §7.2).
 * Frames stay in a RAM ring buffer; only metadata leaves the renderer
 * unless main explicitly asks for a frame for Vision. OCR summaries of
 * high-change frames are the one exception, and they are short text.
 */
export class ScreenStreamManager {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly buffer = new FrameRingBuffer<Blob>(20_000);
  private readonly canvas = document.createElement('canvas');
  private readonly hashCanvas = document.createElement('canvas');
  private readonly regions = new RegionChangeTracker();
  private readonly ocr = new OcrPipeline((frame, text) => this.onOcrText(frame, text));
  private lastHash: string | null = null;
  private lastStoredAt = 0;
  private seq = 0;
  private sourceId: string | null = null;
  private paused = false;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeOcr: (() => void) | null = null;

  async start(sourceId: string, sourceName: string, kind: 'screen' | 'window', fps: number): Promise<MediaStream> {
    await this.stop();
    // Tell main which source to hand to getDisplayMedia, then request it.
    await window.navi.capture.start(sourceId, sourceName, kind);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false });
    this.stream = stream;
    this.sourceId = sourceId;
    // Main starts every share unpaused; match it so a share started while paused is sampled.
    this.paused = false;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play();

    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => void this.stop());
    // OCR stays off until the user's settings are known, then follows them for the whole share.
    this.unsubscribeOcr = window.navi.capture.onOcrConfig((s) => this.ocr.configure(ocrConfigFrom(s)));
    const settings = await window.navi.settings.get().catch(() => null);
    if (this.stream !== stream) return stream; // stopped meanwhile
    if (settings) this.ocr.configure(ocrConfigFrom(settings));
    this.timer = setInterval(() => void this.sample(), Math.max(100, 1000 / fps));
    this.unsubscribe = window.navi.capture.onFrameRequest((req) => void this.answer(req.requestId, req.which));
    return stream;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeOcr?.();
    this.unsubscribeOcr = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    const wasSharing = this.stream !== null;
    this.stream = null;
    this.video = null;
    this.sourceId = null;
    this.lastHash = null;
    this.regions.reset();
    // Free the OCR worker; a late result from this share is dropped.
    this.ocr.reset({ dispose: true });
    // Switching or stopping drops the old frames so they are never mistaken for the current screen.
    this.buffer.clear();
    if (wasSharing) await window.navi.capture.stop();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.buffer.clear();
      this.regions.reset();
      this.ocr.reset({ dispose: false });
    }
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
    const pixels = hctx.getImageData(0, 0, HASH_W, HASH_H).data;
    const hash = dHash(pixels, HASH_W, HASH_H);
    const change = this.lastHash ? hashDistance(hash, this.lastHash) : 1;
    this.lastHash = hash;
    const region = this.regions.update(pixels, HASH_W, HASH_H);

    const scale = Math.min(1, MAX_W / video.videoWidth, MAX_H / video.videoHeight);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    const frameId = `${this.sourceId}#${++this.seq}`;
    const summary: FrameSummary = {
      frameId,
      capturedAt: now,
      sourceId: this.sourceId,
      hash,
      change,
      width,
      height,
      changedRegions: region.changedRegions,
      sceneScore: region.sceneScore,
    };
    window.navi.capture.sendFrameSummary(summary);

    const ocrStarted = this.ocr.offer(
      video,
      { frameId, sourceId: summary.sourceId, capturedAt: now },
      { at: now, change, cellChanges: region.changes },
    );

    const quiet = change < 0.05 && region.sceneScore < STORE_SCENE_SCORE;
    if (quiet && !ocrStarted && now - this.lastStoredAt < KEYFRAME_MS) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.getContext('2d')!.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((r) => this.canvas.toBlob(r, 'image/jpeg', 0.8));
    if (!blob || this.sourceId !== summary.sourceId) return;
    this.lastStoredAt = now;
    this.buffer.push({
      frameId,
      capturedAt: now,
      sourceId: summary.sourceId,
      hash,
      change,
      sceneScore: region.sceneScore,
      image: blob,
    });
  }

  /** OCR finished: keep the text with its frame in RAM and hand main the short summary. */
  private onOcrText(frame: OcrFrameRef, text: string): void {
    if (this.paused || this.sourceId !== frame.sourceId) return;
    this.buffer.annotate(frame.frameId, { ocrSummary: text });
    window.navi.capture.sendOcrSummary({ ...frame, text });
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
