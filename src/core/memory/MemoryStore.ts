/**
 * Memory tiers (design doc §6.5). The interface is storage-agnostic; the
 * in-memory implementation is used until the SQLite store (PR-09) lands.
 */
export type MemoryTier = 'session' | 'long';

export interface MemoryItem {
  id: string;
  tier: MemoryTier;
  text: string;
  createdAt: number;
  lastUsedAt: number;
  uses: number;
}

export interface MemoryStore {
  write(text: string, tier: MemoryTier, at: number): MemoryItem;
  /** Simple relevance search; returns the best matches first. */
  recall(query: string, limit?: number): MemoryItem[];
  list(tier?: MemoryTier): MemoryItem[];
  remove(id: string): void;
  clearSession(): void;
}

function bigrams(text: string): Set<string> {
  const s = text.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Character-bigram overlap works reasonably for Japanese without a tokenizer. */
function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

export class InMemoryMemoryStore implements MemoryStore {
  private items: MemoryItem[] = [];
  private seq = 0;

  write(text: string, tier: MemoryTier, at: number): MemoryItem {
    const trimmed = text.trim();
    const dup = this.items.find((m) => similarity(m.text, trimmed) > 0.85);
    if (dup) {
      dup.lastUsedAt = at;
      if (tier === 'long') dup.tier = 'long';
      return dup;
    }
    const item: MemoryItem = { id: `m${++this.seq}`, tier, text: trimmed, createdAt: at, lastUsedAt: at, uses: 0 };
    this.items.push(item);
    return item;
  }

  recall(query: string, limit = 5): MemoryItem[] {
    return this.items
      .map((m) => ({ m, s: similarity(m.text, query) }))
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
    this.items = this.items.filter((m) => m.tier === 'long');
  }
}
