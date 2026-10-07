/**
 * Tokenizer-free text matching for Japanese (design doc §6.5). Character
 * bigrams work reasonably without a morphological analyzer, and the same
 * grams feed the SQLite FTS5 index so both recall paths agree.
 */

/** NFKC + lowercase, keeping only letters and digits (drops spaces and punctuation). */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function bigrams(text: string): Set<string> {
  const s = normalizeForMatch(text);
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n;
}

/**
 * Overlap coefficient: how much of the shorter text appears in the longer.
 * Good for recall, where a short query should match a longer memory.
 */
export function overlap(a: string, b: string): number {
  return overlapOf(bigrams(a), bigrams(b));
}

export function overlapOf(A: Set<string>, B: Set<string>): number {
  if (A.size === 0 || B.size === 0) return 0;
  return intersectionSize(A, B) / Math.min(A.size, B.size);
}

/**
 * Dice coefficient: symmetric, so a short fact is not a "duplicate" of a
 * longer one that merely contains it. Used for dedupe.
 */
export function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  return (2 * intersectionSize(A, B)) / (A.size + B.size);
}
