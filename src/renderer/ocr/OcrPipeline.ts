/**
 * Screen OCR glue for ScreenStreamManager (design doc §7.2 "high change → OCR").
 * The gate picks the moment, the frame is cropped to where it changed and
 * converted to grayscale, and the runner reads it in a Web Worker. Only a
 * short cleaned summary leaves this module; the text is never logged (§20).
 */
import { OCR_SUMMARY_MAX_CHARS, summarizeOcrText } from '../../core/screen/OcrAnalysis';
import { OCR_OFF, OcrGate, ocrIntervalMs, type OcrConfig, type OcrFrameInfo } from './OcrGate';
import { ocrCropRect, ocrOutputSize, rgbaToPgm } from './ocrImage';
import { OcrRunner, type OcrEngineFactory } from './OcrRunner';
import { createTesseractEngine } from './TesseractEngine';

export interface OcrFrameRef {
  frameId: string;
  sourceId: string;
  capturedAt: number;
}

/** Copies the part of the live video to OCR into a grayscale image. */
export type FrameGrabber = (video: HTMLVideoElement, cells: number[]) => Uint8Array | null;

/** Below this mean confidence the "text" is mostly texture read as glyphs. */
const MIN_CONFIDENCE = 35;
/** Re-reading an unchanged screen is not news. */
const REPEAT_SUPPRESS_MS = 30_000;

/** Draws the changed area of the video into a canvas and returns it as PGM. */
export function canvasGrabber(): FrameGrabber {
  const canvas = document.createElement('canvas');
  return (video, cells) => {
    const crop = ocrCropRect(cells, video.videoWidth, video.videoHeight);
    const { width, height } = ocrOutputSize(crop);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
    const pgm = rgbaToPgm(ctx.getImageData(0, 0, width, height).data, width, height);
    // Do not leave a copy of the screen in a canvas outside the ring buffer.
    canvas.width = 0;
    canvas.height = 0;
    return pgm;
  };
}

export class OcrPipeline {
  private readonly gate = new OcrGate();
  private readonly runner: OcrRunner;
  private readonly grab: FrameGrabber;
  private config: OcrConfig = OCR_OFF;
  /** Bumped on stop / pause / switch so late results from an old screen are dropped. */
  private generation = 0;
  private lastSent: { text: string; at: number } | null = null;

  constructor(
    private readonly onText: (frame: OcrFrameRef, summary: string) => void,
    deps: { factory?: OcrEngineFactory; grab?: FrameGrabber } = {},
  ) {
    this.runner = new OcrRunner(deps.factory ?? createTesseractEngine);
    this.grab = deps.grab ?? canvasGrabber();
  }

  configure(cfg: OcrConfig): void {
    const prev = this.config;
    this.config = cfg;
    this.gate.configure(cfg);
    if (ocrIntervalMs(cfg) === null) {
      this.generation++;
      this.runner.dispose();
    } else if (!prev.enabled && cfg.enabled) {
      // The user explicitly switched OCR back on: retry even after an earlier failure.
      this.runner.reenable();
    }
  }

  /** Share stopped, paused or switched: drop pending work and any in-flight result. */
  reset(opts: { dispose: boolean }): void {
    this.generation++;
    this.gate.reset();
    this.lastSent = null;
    if (opts.dispose) this.runner.dispose();
    else this.runner.cancel();
  }

  /**
   * Called for every sampled frame with the live video. Returns true when an
   * OCR job started on this frame (the caller then keeps it in the ring buffer).
   */
  offer(video: HTMLVideoElement, frame: OcrFrameRef, info: OcrFrameInfo): boolean {
    if (this.runner.disabled || video.videoWidth === 0) return false;
    const trigger = this.gate.offer(info, this.runner.busy);
    if (!trigger) return false;
    const image = this.grab(video, trigger.cells);
    if (!image) return false;

    const generation = this.generation;
    void this.runner.run(image).then((res) => {
      if (!res || generation !== this.generation || res.confidence < MIN_CONFIDENCE) return;
      const summary = summarizeOcrText(res.text, OCR_SUMMARY_MAX_CHARS);
      if (!summary) return;
      const last = this.lastSent;
      if (last && last.text === summary && frame.capturedAt - last.at < REPEAT_SUPPRESS_MS) return;
      this.lastSent = { text: summary, at: frame.capturedAt };
      this.onText(frame, summary);
    });
    return true;
  }
}
