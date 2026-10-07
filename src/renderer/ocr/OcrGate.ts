/**
 * Decides when the renderer may spend CPU on OCR (design doc §4, §7.2):
 * only after a high-change frame, once the screen has settled, and no more
 * often than the resource mode allows. Pure, so it is unit-tested.
 */
import type { ResourceMode } from '../../core/resource/ResourceGovernor';
import { changedCells, REGION_CHANGED } from '../../core/screen/RegionHash';

export interface OcrConfig {
  enabled: boolean;
  mode: ResourceMode;
  /** GAME_PRIORITY keeps OCR off unless the user turns it back on. */
  allowInGamePriority: boolean;
}

export const DEFAULT_OCR_CONFIG: OcrConfig = { enabled: true, mode: 'BALANCED', allowInGamePriority: false };
/** Until settings arrive OCR does nothing: a user who switched it off is never read even once. */
export const OCR_OFF: OcrConfig = { ...DEFAULT_OCR_CONFIG, enabled: false };

/** Settings as main pushes them (OcrSettingsPush) → scheduler config. */
export function ocrConfigFrom(s: {
  ocrEnabled?: boolean;
  ocrInGamePriority?: boolean;
  resourceMode?: ResourceMode;
}): OcrConfig {
  return {
    enabled: s.ocrEnabled ?? DEFAULT_OCR_CONFIG.enabled,
    mode: s.resourceMode ?? DEFAULT_OCR_CONFIG.mode,
    allowInGamePriority: s.ocrInGamePriority ?? DEFAULT_OCR_CONFIG.allowInGamePriority,
  };
}

/** Minimum gap between OCR runs, or null when OCR is off. */
export function ocrIntervalMs(cfg: OcrConfig): number | null {
  if (!cfg.enabled) return null;
  switch (cfg.mode) {
    case 'GAME_PRIORITY':
      return cfg.allowInGamePriority ? 5_000 : null;
    case 'BALANCED':
      return 3_000;
    case 'DESKTOP_CHAT':
      return 1_500;
  }
}

/** Per-frame numbers the gate looks at (from FrameDiff + RegionHash). */
export interface OcrFrameInfo {
  at: number;
  /** Whole-frame dHash change 0..1. */
  change: number;
  /** Per-cell change from RegionHash. */
  cellChanges: readonly number[];
}

export interface OcrTrigger {
  /** Grid cells that changed since the change began; empty = read the whole frame. */
  cells: number[];
}

/** Same cut as FrameDiff.classifyChange 'high'. */
const HIGH_CHANGE = 0.25;
/** A strong change in one cell (a price tooltip popping up) is high-change too. */
const HIGH_CELL = 0.3;
const CALM_CHANGE = 0.05;
/** Never wait longer than this for the screen to settle (video, gameplay). */
const MAX_SETTLE_WAIT_MS = 1_500;
/** Continuous motion stretches the interval up to this factor. */
const MAX_BACKOFF = 4;

export class OcrGate {
  private interval: number | null = ocrIntervalMs(OCR_OFF);
  private dirtySince: number | null = null;
  private dirtyCells = new Set<number>();
  private lastRunAt = -Infinity;
  private backoff = 1;

  configure(cfg: OcrConfig): void {
    this.interval = ocrIntervalMs(cfg);
    if (this.interval === null) this.reset();
  }

  get enabled(): boolean {
    return this.interval !== null;
  }

  /** Forget a pending change (share stopped, paused or switched). The rate limit is kept. */
  reset(): void {
    this.dirtySince = null;
    this.dirtyCells.clear();
    this.backoff = 1;
  }

  /**
   * Called for every sampled frame. Returns a trigger when OCR should run on
   * this frame; `busy` means a previous job is still running.
   */
  offer(f: OcrFrameInfo, busy: boolean): OcrTrigger | null {
    if (this.interval === null) return null;

    const peakCell = Math.max(0, ...f.cellChanges);
    if (f.change >= HIGH_CHANGE || peakCell >= HIGH_CELL) {
      this.dirtySince ??= f.at;
      for (const c of changedCells(f.cellChanges)) this.dirtyCells.add(c);
    }
    if (this.dirtySince === null) return null;

    // Read the settled frame, not a half-drawn transition.
    const calm = f.change < CALM_CHANGE && peakCell < REGION_CHANGED;
    if (!calm && f.at - this.dirtySince < MAX_SETTLE_WAIT_MS) return null;
    if (busy || f.at - this.lastRunAt < this.interval * this.backoff) return null;

    // A screen that never settles (video, gameplay) is read less and less often.
    this.backoff = calm ? 1 : Math.min(MAX_BACKOFF, this.backoff * 2);
    this.lastRunAt = f.at;
    const cells = [...this.dirtyCells].sort((a, b) => a - b);
    this.dirtySince = null;
    this.dirtyCells.clear();
    return { cells };
  }
}
