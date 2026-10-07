import { overlap } from './similarity';

/**
 * Memory tiers (design doc §6.5). Working memory is ConversationManager;
 * 'session' is today's play; 'long' is what is worth reusing across sessions.
 * The interface is storage-agnostic: SqliteMemoryStore is the durable store,
 * InMemoryMemoryStore the fallback when SQLite cannot be opened (§19).
 */
export type MemoryTier = 'session' | 'long';

/** Where a memory came from: the model's memory_write, the session summary, or the user. */
export type MemorySource = 'conversation' | 'summary' | 'user';

export interface MemoryItem {
  id: string;
  tier: MemoryTier;
  text: string;
  createdAt: number;
  lastUsedAt: number;
  uses: number;
  source?: MemorySource;
}

export interface MemoryStore {
  write(text: string, tier: MemoryTier, at: number, source?: MemorySource): MemoryItem;
  /** Simple relevance search; returns the best matches first. */
  recall(query: string, limit?: number): MemoryItem[];
  list(tier?: MemoryTier): MemoryItem[];
  remove(id: string): void;
  clearSession(): void;
}

export interface MemoryStats {
  backend: 'sqlite' | 'memory';
  /** SQLite FTS5 is narrowing recall candidates. */
  fts: boolean;
  long: number;
  session: number;
  utterances: number;
  screenEvents: number;
  topics: number;
  sessions: number;
  /** Why the durable store is not in use, when it is not. */
  error?: string;
}

/** What the Memory tab needs on top of the conversation-facing interface. */
export interface ManagedMemoryStore extends MemoryStore {
  /** Edit a memory's text. Returns null when the id is unknown or the text is empty. */
  update(id: string, text: string): MemoryItem | null;
  /** UI search: substring + similarity, with no side effects on use counts. */
  search(query: string, opts?: { tier?: MemoryTier; limit?: number }): MemoryItem[];
  clearTier(tier: MemoryTier): void;
  /** Forget everything the user said or Navi learned (keeps plugin data). */
  clearAll(): void;
  stats(): MemoryStats;
  close(): void;
}

export function isManagedMemoryStore(store: MemoryStore): store is ManagedMemoryStore {
  const s = store as Partial<ManagedMemoryStore>;
  return typeof s.update === 'function' && typeof s.clearAll === 'function' && typeof s.stats === 'function';
}

/** Ranking shared by both stores for the UI search box. */
export function searchScore(text: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  return (text.toLowerCase().includes(q) ? 1 : 0) + overlap(text, query);
}

export const SEARCH_MIN_SCORE = 0.3;

export class InMemoryMemoryStore implements ManagedMemoryStore {
  private items: MemoryItem[] = [];
  private seq = 0;

  write(text: string, tier: MemoryTier, at: number, source?: MemorySource): MemoryItem {
    const trimmed = text.trim();
    const dup = this.items.find((m) => overlap(m.text, trimmed) > 0.85);
    if (dup) {
      dup.lastUsedAt = at;
      if (tier === 'long') dup.tier = 'long';
      return dup;
    }
    const item: MemoryItem = { id: `m${++this.seq}`, tier, text: trimmed, createdAt: at, lastUsedAt: at, uses: 0 };
    if (source) item.source = source;
    this.items.push(item);
    return item;
  }

  recall(query: string, limit = 5): MemoryItem[] {
    return this.items
      .map((m) => ({ m, s: overlap(m.text, query) }))
      .filter((x) => x.s > 0.15)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => {
        x.m.uses++;
        return x.m;
      });
  }

  list(tier?: MemoryTier): MemoryItem[] {
    return this.items.filter((m) => !tier || m.tier === tier);
  }

  remove(id: string): void {
    this.items = this.items.filter((m) => m.id !== id);
  }

  clearSession(): void {
    this.clearTier('session');
  }

  update(id: string, text: string): MemoryItem | null {
    const trimmed = text.trim();
    const item = this.items.find((m) => m.id === id);
    if (!item || !trimmed) return null;
    item.text = trimmed;
    item.source = 'user';
    return item;
  }

  search(query: string, opts: { tier?: MemoryTier; limit?: number } = {}): MemoryItem[] {
    const pool = this.list(opts.tier);
    if (!query.trim()) return pool.slice(0, opts.limit ?? pool.length);
    return pool
      .map((m) => ({ m, s: searchScore(m.text, query) }))
      .filter((x) => x.s >= SEARCH_MIN_SCORE)
      .sort((a, b) => b.s - a.s)
      .slice(0, opts.limit ?? 100)
      .map((x) => x.m);
  }

  clearTier(tier: MemoryTier): void {
    this.items = this.items.filter((m) => m.tier !== tier);
  }

  clearAll(): void {
    this.items = [];
  }

  stats(): MemoryStats {
    return {
      backend: 'memory',
      fts: false,
      long: this.items.filter((m) => m.tier === 'long').length,
      session: this.items.filter((m) => m.tier === 'session').length,
      utterances: 0,
      screenEvents: 0,
      topics: 0,
      sessions: 0,
    };
  }

  close(): void {
    // Nothing to release.
  }
}
