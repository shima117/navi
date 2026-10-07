/**
 * Decides whether Navi should start talking on her own (design doc §6.4, §10).
 * There is no periodic timer that makes her speak: every candidate is scored
 * and most are discarded.
 */
export type CandidateSource = 'screen' | 'plugin' | 'silence' | 'callback' | 'own_topic';

export interface InitiativeCandidate {
  source: CandidateSource;
  description: string;
  /** All 0..1 */
  eventImportance: number;
  novelty: number;
  userInterest: number;
  screenRelevance: number;
  callbackValue: number;
  topicKey?: string;
}

export interface InitiativeContext {
  now: number;
  lastNaviSpeechAt: number | null;
  lastUserSpeechAt: number | null;
  userSpeaking: boolean;
  /** A plugin reported a focus situation (combat etc.). */
  focus: boolean;
  /** Recent screen change level 0..1; big changes mean the user is busy. */
  screenActivity: number;
  fatigue: number;
  quiet: boolean;
}

export interface InitiativeConfig {
  threshold: number;
  /** Navi spoke within this window → strong penalty. */
  recentSpeechMs: number;
  /** Silence alone never justifies talking before this (§10.2). */
  minSilenceMs: number;
  quietThresholdBoost: number;
}

export const DEFAULT_INITIATIVE: InitiativeConfig = {
  threshold: 0.5,
  recentSpeechMs: 45_000,
  minSilenceMs: 90_000,
  quietThresholdBoost: 0.2,
};

export interface InitiativeDecision {
  speak: boolean;
  score: number;
  reason: string;
  candidate?: InitiativeCandidate;
}

export class InitiativeScheduler {
  private recentTopics: Array<{ key: string; at: number }> = [];

  constructor(
    private readonly config: InitiativeConfig = DEFAULT_INITIATIVE,
    private readonly random: () => number = Math.random,
  ) {}

  score(c: InitiativeCandidate, ctx: InitiativeContext): number {
    const base =
      c.eventImportance * 0.3 +
      c.novelty * 0.2 +
      c.userInterest * 0.15 +
      c.screenRelevance * 0.15 +
      c.callbackValue * 0.1 +
      this.random() * 0.1;

    const focusPenalty = (ctx.focus ? 0.6 : 0) + Math.max(0, ctx.screenActivity - 0.5) * 0.4;
    const sinceNavi = ctx.lastNaviSpeechAt === null ? Infinity : ctx.now - ctx.lastNaviSpeechAt;
    const recentSpeechPenalty =
      sinceNavi < this.config.recentSpeechMs ? 0.4 * (1 - sinceNavi / this.config.recentSpeechMs) + 0.1 : 0;
    const repeatPenalty =
      c.topicKey && this.recentTopics.some((t) => t.key === c.topicKey && ctx.now - t.at < 300_000) ? 0.3 : 0;
    const fatiguePenalty = ctx.fatigue * 0.2 + repeatPenalty;

    return base - focusPenalty - recentSpeechPenalty - fatiguePenalty;
  }

  /** Choose the best candidate, or decide to stay silent. Silence is a valid answer. */
  decide(candidates: InitiativeCandidate[], ctx: InitiativeContext): InitiativeDecision {
    if (ctx.userSpeaking) return { speak: false, score: 0, reason: 'user_speaking' };

    const lastActivity = Math.max(ctx.lastNaviSpeechAt ?? -Infinity, ctx.lastUserSpeechAt ?? -Infinity);
    const silenceMs = ctx.now - lastActivity;
    const eligible = candidates.filter(
      (c) => !(c.source === 'silence' || c.source === 'own_topic') || silenceMs >= this.config.minSilenceMs,
    );
    if (eligible.length === 0) return { speak: false, score: 0, reason: 'no_candidates' };

    let best: InitiativeCandidate | undefined;
    let bestScore = -Infinity;
    for (const c of eligible) {
      const s = this.score(c, ctx);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }

    const threshold = this.config.threshold + (ctx.quiet ? this.config.quietThresholdBoost : 0);
    if (!best || bestScore < threshold) {
      return { speak: false, score: bestScore, reason: ctx.focus ? 'focus' : 'below_threshold' };
    }
    if (best.topicKey) {
      this.recentTopics.push({ key: best.topicKey, at: ctx.now });
      this.recentTopics = this.recentTopics.filter((t) => ctx.now - t.at < 600_000);
    }
    return { speak: true, score: bestScore, reason: 'selected', candidate: best };
  }
}
