/**
 * Hard post-processing of Navi's speech (design doc §8.3). The LLM is asked to
 * follow these rules, but they are enforced here regardless.
 */
export const MAX_SENTENCES = 3;
export const MAX_CHARS = 180;

/** Customer-service phrases Navi never says. The whole sentence is dropped. */
const BANNED_PHRASES = [
  /他に(何か|なにか)/,
  /お手伝い(でき|し)/,
  /いかがでしょうか/,
  /何でも(聞いて|お気軽)/,
  /お気軽に/,
  /お役に立て/,
  /ご質問があれば/,
];

export interface StyleResult {
  text: string;
  sentences: string[];
  /** Over MAX_CHARS even after trimming; caller should regenerate. */
  needsRegenerate: boolean;
  endsWithQuestion: boolean;
}

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  const chars = [...text.replace(/\r?\n+/g, '\n')];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === '\n') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
    if ('。！？!?'.includes(c)) {
      // Keep closing brackets/repeated punctuation attached to the sentence.
      while (i + 1 < chars.length && '。！？!?」』）)…'.includes(chars[i + 1]!)) buf += chars[++i];
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export function isQuestion(sentence: string): boolean {
  return /[？?]$/.test(sentence) || /(ですか|ますか|でしょうか)[。」]?$/.test(sentence);
}

export interface EnforceOptions {
  /** Drop a trailing question when there is other content (used when Navi has been asking too much). */
  suppressTrailingQuestion?: boolean;
}

export function enforceStyle(text: string, opts: EnforceOptions = {}): StyleResult {
  let sentences = splitSentences(text.trim()).filter((s) => !BANNED_PHRASES.some((p) => p.test(s)));

  if (opts.suppressTrailingQuestion && sentences.length > 1 && isQuestion(sentences[sentences.length - 1]!)) {
    sentences = sentences.slice(0, -1);
  }
  if (sentences.length > MAX_SENTENCES) sentences = sentences.slice(0, MAX_SENTENCES);

  // Japanese sentences are joined without spaces.
  const joined = sentences.join('');
  const last = sentences[sentences.length - 1];
  return {
    text: joined,
    sentences,
    needsRegenerate: [...joined].length > MAX_CHARS,
    endsWithQuestion: last !== undefined && isQuestion(last),
  };
}
