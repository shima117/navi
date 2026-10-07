/**
 * Detects when the user is talking about the shared screen (design doc §7.4).
 */
export type ScreenReferenceKind = 'none' | 'current' | 'recent';

const RECENT_PATTERNS = [/今の/, /さっきの/, /いまの/, /今なんか/, /今何/];
const CURRENT_PATTERNS = [
  /これ/,
  /こっち/,
  /あれ/,
  /それ(?!で|じゃ|より|に|は)/,
  /この(画面|ページ|商品|アイテム|武器|服|動画|人|キャラ)?/,
  /画面/,
  /右(の|側|上|下)/,
  /左(の|側|上|下)/,
  /上の/,
  /下の/,
  /真ん中/,
  /どう思う/,
  /見て/,
  /見える/,
];

export function detectScreenReference(text: string): ScreenReferenceKind {
  const t = text.trim();
  if (!t) return 'none';
  if (RECENT_PATTERNS.some((p) => p.test(t))) return 'recent';
  if (CURRENT_PATTERNS.some((p) => p.test(t))) return 'current';
  return 'none';
}
