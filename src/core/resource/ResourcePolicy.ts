import type { ResourceMode } from './ResourceGovernor';

/**
 * Automatic resource-mode selection (design doc §4, PR-10). The situation
 * decides, not a timer: a game needs the GPU, a shared non-game window can
 * spare some, and plain desktop chat can afford the large vision model.
 */
export interface ResourceSituation {
  /** Setting autoResourceMode; false = the user's manual choice wins. */
  auto: boolean;
  manualMode: ResourceMode;
  /** A GamePlugin is active (auto-detected from the shared window or chosen in Games). */
  gameActive: boolean;
  /** A source is being shared (paused counts: the user is still in that app). */
  sharing: boolean;
}

export type ResourceReason = 'manual' | 'game' | 'sharing' | 'idle';

export interface ResourceDecision {
  mode: ResourceMode;
  reason: ResourceReason;
}

export function decideResourceMode(s: ResourceSituation): ResourceDecision {
  if (!s.auto) return { mode: s.manualMode, reason: 'manual' };
  if (s.gameActive) return { mode: 'GAME_PRIORITY', reason: 'game' };
  if (s.sharing) return { mode: 'BALANCED', reason: 'sharing' };
  return { mode: 'DESKTOP_CHAT', reason: 'idle' };
}

export interface ResourceTransition {
  /** Free the large vision model's VRAM right away instead of waiting for its keep-alive. */
  unloadLargeVision: boolean;
}

/** What to do when the effective mode changes (prev = null at startup). */
export function transitionActions(prev: ResourceMode | null, next: ResourceMode): ResourceTransition {
  return { unloadLargeVision: next === 'GAME_PRIORITY' && prev !== 'GAME_PRIORITY' };
}
