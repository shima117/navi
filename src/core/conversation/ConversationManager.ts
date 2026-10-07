import type { Temperature, TopicAction, Turn } from '../types';

/**
 * Short-term conversational state (design doc §6.3): recent turns, the
 * current topic, topic fatigue, and when Navi last spoke.
 */
export interface ConversationSnapshot {
  turns: Turn[];
  topic: string | null;
  fatigue: number;
  lastSpeakAt: number | null;
  lastUserAt: number | null;
  speaking: boolean;
  questionRate: number;
}

/** Topics Navi reacts more strongly to (§9: extreme penny-pincher). */
const INTEREST_KEYWORDS: Array<[RegExp, number]> = [
  [/(円|万|値段|高い|安い|セール|割引|半額|ルーブル|₽|金|買|売)/, 0.35],
  [/(酒|ビール|バナナ|眼鏡|メガネ)/, 0.25],
  [/(ゲーム|死んだ|やられ|負け|勝っ|レイド|ボス)/, 0.2],
];

export class ConversationManager {
  private turns: Turn[] = [];
  private topic: string | null = null;
  private fatigue = 0;
  private lastSpeakAt: number | null = null;
  private lastUserAt: number | null = null;
  private speaking = false;
  private recentNaviQuestions: boolean[] = [];

  constructor(private readonly maxTurns = 30) {}

  addUserTurn(text: string, at: number): void {
    this.push({ role: 'user', text, at });
    this.lastUserAt = at;
  }

  addNaviTurn(text: string, at: number, endsWithQuestion: boolean): void {
    this.push({ role: 'navi', text, at });
    this.lastSpeakAt = at;
    this.recentNaviQuestions.push(endsWithQuestion);
    if (this.recentNaviQuestions.length > 10) this.recentNaviQuestions.shift();
  }

  /** Barge-in: mark the latest Navi turn as cut off (design doc §11.2). */
  markInterrupted(): void {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i]!;
      if (t.role === 'navi') {
        t.interrupted = true;
        break;
      }
    }
    this.speaking = false;
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
  }

  /** Update topic and fatigue from the model's topic_action. */
  applyTopicAction(action: TopicAction, topicHint?: string): void {
    if (action === 'continue') {
      this.fatigue = Math.min(1, this.fatigue + 0.15);
    } else {
      this.fatigue = 0;
      this.topic = action === 'drop' ? null : (topicHint ?? this.topic);
    }
    if (topicHint && !this.topic) this.topic = topicHint;
  }

  /** Interest score for a piece of text, 0..1, including fatigue. */
  interestScore(text: string): number {
    let score = 0.3;
    for (const [re, weight] of INTEREST_KEYWORDS) if (re.test(text)) score += weight;
    return Math.max(0, Math.min(1, score - this.fatigue * 0.4));
  }

  /** Suggested reply temperature given the user's text (§8.4). */
  suggestTemperature(text: string): Temperature {
    const s = this.interestScore(text);
    if (s >= 0.6) return 'dense';
    if (s <= 0.25) return 'thin';
    return 'normal';
  }

  get questionRate(): number {
    if (this.recentNaviQuestions.length === 0) return 0;
    return this.recentNaviQuestions.filter(Boolean).length / this.recentNaviQuestions.length;
  }

  recentTurns(n = 12): Turn[] {
    return this.turns.slice(-n);
  }

  snapshot(): ConversationSnapshot {
    return {
      turns: this.turns.map((t) => ({ ...t })),
      topic: this.topic,
      fatigue: this.fatigue,
      lastSpeakAt: this.lastSpeakAt,
      lastUserAt: this.lastUserAt,
      speaking: this.speaking,
      questionRate: this.questionRate,
    };
  }

  private push(turn: Turn): void {
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) this.turns.splice(0, this.turns.length - this.maxTurns);
  }
}
