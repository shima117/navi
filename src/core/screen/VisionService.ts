import type { OllamaClient } from '../ai/OllamaClient';
import type { ModelRouter } from '../ai/ModelRouter';
import type { ResourceGovernor } from '../resource/ResourceGovernor';
import type { ScreenObservation } from '../types';
import type { ScreenReferenceKind } from './ScreenReference';

/** A frame handed to Vision. Pixels stay in RAM and are never logged. */
export interface VisionFrame {
  frameId: string;
  capturedAt: number;
  sourceId: string;
  sourceName: string;
  /** Base64 JPEG/WebP without a data: prefix. */
  imageBase64: string;
}

/**
 * Cheap screen context gathered before Vision runs (§7.4): where the screen
 * changed recently and what OCR read. Only used when it belongs to the frame's source.
 */
export interface VisionHints {
  sourceId: string;
  /** e.g. ['右下'] — helps resolve 「右の」「これ」. */
  changedRegions?: readonly string[];
  /** Latest OCR summary (may contain misreads). */
  ocrText?: string;
}

/** Where frames come from (the renderer's ring buffer, over IPC in Electron). */
export interface FrameProvider {
  /** 'latest' = freshest frame now; 'recent' = representative frame from 2–6 s ago. */
  getFrame(which: 'latest' | 'recent'): Promise<VisionFrame | null>;
}

const VISION_PROMPT = [
  'あなたはPC画面の観察係。画面を見て、次のJSONだけを返す。',
  '{"summary": string (画面に何が映っているか日本語1〜2文),',
  ' "referent": string|null (ユーザーの言う「これ」等が指していそうな対象。不明ならnull),',
  ' "ocr": string (目立つ文字や数字・値段を短く),',
  ' "confidence": number (0..1, 自分の認識の自信)}',
  '推測で断定しない。見えないものを書かない。',
  '「変化した領域」があれば、それは直前に画面が変わった場所。「これ」「右」「左」が指す対象の手がかりにする。',
  '「OCRで読めた文字」は誤読を含みうる。画像と食い違えば画像を優先する。',
].join('\n');

interface VisionJson {
  summary?: unknown;
  referent?: unknown;
  ocr?: unknown;
  confidence?: unknown;
}

export class VisionService {
  constructor(
    private readonly ollama: OllamaClient,
    private readonly router: ModelRouter,
    private readonly governor: ResourceGovernor,
    private readonly frames: FrameProvider,
  ) {}

  /**
   * Look at the screen. Returns null when nothing could honestly be seen
   * (no share, rate-limited, model down) so callers never pretend.
   */
  async observe(
    kind: Exclude<ScreenReferenceKind, 'none'>,
    userText: string | null,
    opts: { highPriority: boolean; now: number; signal?: AbortSignal; hints?: VisionHints },
  ): Promise<ScreenObservation | null> {
    if (!this.governor.tryAcquireVision(opts.now, opts.highPriority)) return null;
    const frame = await this.frames.getFrame(kind === 'recent' ? 'recent' : 'latest');
    if (!frame) return null;
    // Hints from a previously shared source would describe the wrong screen.
    const hints = opts.hints?.sourceId === frame.sourceId ? opts.hints : undefined;

    let obs = await this.ask(frame, userText, false, opts.signal, hints);
    if (obs && this.router.shouldEscalate(obs.confidence)) {
      obs = (await this.ask(frame, userText, true, opts.signal, hints)) ?? obs;
    }
    return obs;
  }

  private async ask(
    frame: VisionFrame,
    userText: string | null,
    escalate: boolean,
    signal?: AbortSignal,
    hints?: VisionHints,
  ): Promise<ScreenObservation | null> {
    const { model, keepAlive } = this.router.visionModel({ escalate });
    const lines = [userText ? `ユーザーの発言:「${userText}」` : null, `共有中: ${frame.sourceName}`];
    if (hints?.changedRegions?.length) lines.push(`変化した領域: ${hints.changedRegions.join('・')}`);
    if (hints?.ocrText) lines.push(`OCRで読めた文字: ${hints.ocrText}`);
    const raw = await this.ollama.chat({
      model,
      keepAlive,
      format: 'json',
      options: { temperature: 0.2 },
      signal,
      messages: [
        { role: 'system', content: VISION_PROMPT },
        {
          role: 'user',
          content: lines.filter((l) => l !== null).join('\n'),
          images: [frame.imageBase64],
        },
      ],
    });
    let parsed: VisionJson;
    try {
      parsed = JSON.parse(raw) as VisionJson;
    } catch {
      return null;
    }
    if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null;
    const confidence = typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5;
    return {
      frameId: frame.frameId,
      capturedAt: frame.capturedAt,
      sourceId: frame.sourceId,
      sourceName: frame.sourceName,
      summary: parsed.summary.trim(),
      ocrText: typeof parsed.ocr === 'string' ? parsed.ocr : undefined,
      referent: typeof parsed.referent === 'string' && parsed.referent.trim() ? parsed.referent.trim() : undefined,
      confidence,
    };
  }
}
