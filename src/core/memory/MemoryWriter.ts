import type { EventBus } from '../events/EventBus';
import type { Turn } from '../types';
import type { MemoryJournal } from './MemoryJournal';
import type { MemoryStore } from './MemoryStore';
import { TopicTracker } from './TopicTracker';

export interface MemoryPolicy {
  /** Keep memories across sessions (promotion, summaries). */
  persistMemory: boolean;
  /** Log every utterance / screen summary (opt-in, §6.5 "すべての発言を永続保存しない設定"). */
  persistUtterances: boolean;
}

export interface MemoryWriterDeps {
  bus: Pick<EventBus, 'on'>;
  store: MemoryStore;
  /** null with the in-memory fallback: there is nowhere to log to. */
  journal: MemoryJournal | null;
  policy: () => MemoryPolicy;
  /** Receives every turn, e.g. SessionSummarizer's RAM buffer. */
  turns?: { record(turn: Turn): void };
  now?: () => number;
}

/** Plugin events below this importance are noise, not memories. */
export const PLUGIN_EVENT_MIN_IMPORTANCE = 0.3;
/** The same plugin event repeating within this window is logged once. */
const PLUGIN_EVENT_DEDUPE_MS = 60_000;

/**
 * Listens to the bus and decides what reaches storage (design doc §6.5).
 * Memories the model asked for are always kept for the session; utterance
 * and screen logs only when the user opted in.
 */
export class MemoryWriter {
  private readonly topics = new TopicTracker();
  private readonly now: () => number;
  private readonly recentPluginEvents = new Map<string, number>();
  private unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: MemoryWriterDeps) {
    this.now = deps.now ?? Date.now;
  }

  attach(): void {
    if (this.unsubscribe.length) return;
    const { bus } = this.deps;
    this.unsubscribe = [
      bus.on('session.started', ({ at }) => {
        this.topics.reset();
        this.recentPluginEvents.clear();
        this.deps.journal?.beginSession(at);
      }),
      bus.on('session.ended', ({ at }) => this.deps.journal?.endSession(at)),
      // The orchestrator also writes these directly; the store dedupes, so this
      // only matters for other emitters (plugins, future modules).
      bus.on('memory.write', (m) => {
        if (m.text.trim()) this.deps.store.write(m.text, m.tier, this.now());
      }),
      bus.on('voice.transcript', (u) => {
        this.deps.turns?.record({ role: 'user', text: u.text, at: u.at });
        this.topics.noteUserText(u.text);
        if (this.policy().persistUtterances) {
          this.deps.journal?.logUtterance({ role: 'user', text: u.text, source: u.source, at: u.at });
        }
      }),
      bus.on('friend.speak', (s) => {
        const at = this.now();
        this.deps.turns?.record({ role: 'navi', text: s.text, at });
        if (this.policy().persistUtterances) this.deps.journal?.logUtterance({ role: 'navi', text: s.text, at });
      }),
      bus.on('friend.response', (res) => {
        if (!res.speak) return;
        const update = this.topics.onAction(res.topic_action);
        // Topic labels are excerpts of what the user said, so they follow the utterance-log opt-in.
        if (update && this.policy().persistUtterances) this.deps.journal?.bumpTopic({ ...update, at: this.now() });
      }),
      bus.on('screen.observed', (o) => {
        if (!this.policy().persistUtterances) return;
        // Summary text only: never the frame, and not the raw OCR text (§20).
        const summary = o.referent ? `${o.summary} / 指していたもの: ${o.referent}` : o.summary;
        this.deps.journal?.logScreenEvent({ kind: 'vision', source: o.sourceName, summary, at: o.capturedAt });
      }),
      bus.on('plugin.event', (e) => {
        if (!this.policy().persistUtterances || e.importance < PLUGIN_EVENT_MIN_IMPORTANCE) return;
        const key = `${e.pluginId}:${e.description}`;
        const last = this.recentPluginEvents.get(key);
        if (last !== undefined && e.at - last < PLUGIN_EVENT_DEDUPE_MS) return;
        this.recentPluginEvents.set(key, e.at);
        if (this.recentPluginEvents.size > 200) this.recentPluginEvents.clear();
        this.deps.journal?.logScreenEvent({
          kind: 'plugin',
          source: e.pluginId,
          summary: e.description,
          importance: e.importance,
          at: e.at,
        });
      }),
    ];
  }

  detach(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  private policy(): MemoryPolicy {
    return this.deps.policy();
  }
}
