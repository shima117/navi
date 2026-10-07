/**
 * Privacy redaction for anything written to disk (design doc §20). This is
 * not a topic filter (§3.1): conversation content is kept as-is, only
 * credentials and inline images are masked so a shared login screen or a
 * pasted key never lands in navi.sqlite.
 */

export const REDACTED = '[伏せ字]';

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Inline images (data URLs) — frames must never be persisted.
  [/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[画像]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // Well-known API key / token shapes.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // "password: hunter2" / "パスワードは hunter2" — only ASCII-looking values,
  // so ordinary Japanese sentences about passwords stay readable.
  [
    /((?:password|passwd|passcode|pwd|api[ _-]?key|secret|token|パスワード|パスコード|暗証番号|APIキー|トークン)\s*(?:[:：=＝]|は|が)\s*)[!-~]{4,}/gi,
    `$1${REDACTED}`,
  ],
  // Long random-looking tokens (mixed letters and digits, 32+ chars).
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, REDACTED],
];

export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return { text: out, redacted: out !== text };
}

/** True when nothing but redaction markers and punctuation would remain. */
export function isOnlyRedacted(text: string): boolean {
  return text.replaceAll(REDACTED, '').replaceAll('[画像]', '').replace(/[^\p{L}\p{N}]+/gu, '') === '';
}
