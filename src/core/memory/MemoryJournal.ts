import type { MemoryStore } from './MemoryStore';

/**
 * Session bookkeeping and opt-in logs (design doc §6.5). Only the durable
 * store implements this; with the in-memory fallback there is nothing to log.
 */
export interface UtteranceRecord {
  role: 'user' | 'navi';
  text: string;
  source?: 'voice' | 'text';
  at: number;
}

export interface ScreenEventRecord {
  /** 'vision' = Vision/OCR observation, 'plugin' = GamePlugin event. */
  kind: 'vision' | 'plugin';
  /** Window name or plugin id. */
  source: string;
  /** Text only — frames are never persisted (§20). */
  summary: string;
  importance?: number;
  at: number;
}

export type TopicEvent = 'start' | 'continue' | 'drop';

export interface TopicBump {
  label: string;
  event: TopicEvent;
  at: number;
}

export interface TopicRow {
  key: string;
  label: string;
  mentions: number;
  starts: number;
  drops: number;
  sessions: number;
  firstAt: number;
  lastAt: number;
}

export interface PurgeResult {
  utterances: number;
  screenEvents: number;
  topics: number;
  sessionMemories: number;
  sessions: number;
}

export interface MemoryJournal {
  /** Opens a session row (closing any left open by a crash). Returns its id. */
  beginSession(at: number): number | null;
  endSession(at: number): void;
  logUtterance(u: UtteranceRecord): void;
  logScreenEvent(e: ScreenEventRecord): void;
  bumpTopic(t: TopicBump): void;
  /** Drop logs and unused session memories older than the retention window. */
  purge(now: number, retentionDays: number): PurgeResult;
}

export function isMemoryJournal(store: MemoryStore): store is MemoryStore & MemoryJournal {
  const s = store as Partial<MemoryJournal>;
  return typeof s.beginSession === 'function' && typeof s.logUtterance === 'function' && typeof s.purge === 'function';
}

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
export const DEFAULT_RETENTION_DAYS = 30;

/** Settings come from a JSON file the user can edit; never trust the number. */
export function clampRetentionDays(days: unknown): number {
  const n = typeof days === 'number' ? days : Number(days);
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(n)));
}
