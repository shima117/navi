import type { TopicAction } from '../types';
import type { TopicEvent } from './MemoryJournal';

/** Topic labels are short excerpts; long ones would just be an utterance log. */
export const TOPIC_LABEL_MAX = 24;

/** First sentence of the user's line, trimmed to a short label. */
export function topicLabel(text: string): string {
  const first = text.normalize('NFKC').split(/[。．.!?！？\n]/)[0] ?? '';
  const label = first.replace(/\s+/g, ' ').trim();
  return label.length > TOPIC_LABEL_MAX ? label.slice(0, TOPIC_LABEL_MAX) : label;
}

/**
 * Turns the model's topic_action (§8.2) into topic counter updates. A topic
 * is named after the user line that opened it; 'continue' adds a mention,
 * 'shift' opens a new topic, 'drop' closes the current one.
 */
export class TopicTracker {
  private current: string | null = null;
  /** The user's latest line, until a response has consumed it. */
  private pendingUserText: string | null = null;

  noteUserText(text: string): void {
    if (text.trim()) this.pendingUserText = text;
  }

  onAction(action: TopicAction): { label: string; event: TopicEvent } | null {
    const userText = this.pendingUserText;
    this.pendingUserText = null;
    if (action === 'drop') {
      const label = this.current;
      this.current = null;
      return label ? { label, event: 'drop' } : null;
    }
    if (action === 'continue' && this.current) return { label: this.current, event: 'continue' };
    // 'shift' or the first topic. Without a fresh user line (Navi changed the
    // subject on her own) there is nothing to name the topic after.
    const label = userText ? topicLabel(userText) : '';
    this.current = label || null;
    return label ? { label, event: 'start' } : null;
  }

  reset(): void {
    this.current = null;
    this.pendingUserText = null;
  }

  get currentTopic(): string | null {
    return this.current;
  }
}
