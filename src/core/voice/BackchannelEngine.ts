export type BackchannelMood = 'neutral' | 'surprised' | 'concerned';

export interface BackchannelInput {
  now: number;
  userSpeechMs: number;
  phraseBoundary: boolean;
  importantTokenActive: boolean;
  mood: BackchannelMood;
}

export interface BackchannelDecision {
  speak: boolean;
  text?: string;
  mood?: BackchannelMood;
  reason: string;
}

const OPTIONS: Record<BackchannelMood, readonly string[]> = {
  neutral: ['うん', 'はい', 'へえ', 'あー'],
  surprised: ['え', 'えっ'],
  concerned: ['あー……', 'んー……'],
};

/** Deterministic/throttled policy; callers may inject a stable random function for tests. */
export class BackchannelEngine {
  private lastAt = -Infinity;
  private cursor = 0;

  constructor(private readonly minGapMs = 2_100) {}

  decide(input: BackchannelInput): BackchannelDecision {
    if (input.userSpeechMs < 1_000) return { speak: false, reason: 'user speech is short' };
    if (!input.phraseBoundary) return { speak: false, reason: 'not a phrase boundary' };
    if (input.importantTokenActive) return { speak: false, reason: 'important token active' };
    if (input.now - this.lastAt < this.minGapMs) return { speak: false, reason: 'throttled' };
    const choices = OPTIONS[input.mood];
    const text = choices[this.cursor++ % choices.length]!;
    this.lastAt = input.now;
    return { speak: true, text, mood: input.mood, reason: 'phrase boundary' };
  }

  reset(): void {
    this.lastAt = -Infinity;
    this.cursor = 0;
  }
}

