import type { MemoryItem } from './MemoryStore';

const DAY_MS = 86_400_000;

/** Below this bigram overlap a memory is not considered related at all. */
export const MIN_RELEVANCE = 0.15;

export const RANK_WEIGHTS = { relevance: 0.7, recency: 0.2, usage: 0.1 } as const;

/** Recency decays with a ~3 week half-life (30-day time constant). */
const RECENCY_TAU_DAYS = 30;
/** Usage saturates: 20 recalls count as "used a lot". */
const USAGE_SATURATION = 20;

/**
 * Recall score (design doc §6.5): relevance dominates, recency and use count
 * break ties so a fact Navi keeps coming back to wins over a stale one.
 */
export function rankScore(relevance: number, item: Pick<MemoryItem, 'lastUsedAt' | 'uses'>, now: number): number {
  const ageDays = Math.max(0, now - item.lastUsedAt) / DAY_MS;
  const recency = Math.exp(-ageDays / RECENCY_TAU_DAYS);
  const usage = Math.min(1, Math.log1p(Math.max(0, item.uses)) / Math.log1p(USAGE_SATURATION));
  return relevance * RANK_WEIGHTS.relevance + recency * RANK_WEIGHTS.recency + usage * RANK_WEIGHTS.usage;
}
