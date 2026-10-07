import type { ChatMessage } from '../ai/OllamaClient';
import type { Turn } from '../types';
import { redactSecrets } from './redact';

/** The chat model call, injected so tests (and the main process) choose the backend. */
export type SummaryChat = (messages: ChatMessage[], signal: AbortSignal) => Promise<string>;

export interface SessionSummarizerDeps {
  chat: SummaryChat;
  /** Chat model reachable? Offline means skip quietly and try again later (§19). */
  isOnline: () => boolean;
  /** The persistMemory setting: long-term facts are only written when it is on. */
  enabled: () => boolean;
  /** Store one long-term fact. */
  write: (fact: string) => void;
  /** RAM buffer size; old turns fall off. */
  maxTurns?: number;
  timeoutMs?: number;
}

export const MAX_FACTS = 5;
const FACT_MIN_LEN = 4;
const FACT_MAX_LEN = 80;
const TRANSCRIPT_MAX_CHARS = 6000;

const SYSTEM_PROMPT = [
  'あなたは会話ログから、ユーザーについて長く覚えておく価値のある事実だけを抜き出す係です。',
  'ルール:',
  '- 次に話すときにも役立つ、ユーザーの好み・習慣・進めている目標・何度も出た話題だけを選ぶ。',
  '- その場限りの出来事や、ナビ自身についての話は入れない。',
  '- 1件は短い日本語の1文。主語は「ユーザーは」。例: 「ユーザーはサイドストーリーより対人戦が好き」',
  `- 最大${MAX_FACTS}件。該当がなければ空配列。`,
  '- 画像の中身そのもの、パスワード、APIキーは絶対に書かない。',
  '出力は JSON のみ: {"facts": ["...", "..."]}',
].join('\n');

interface BufferedTurn extends Turn {
  seq: number;
}

/**
 * Condenses a session's conversation into a few long-term facts (design doc
 * §6.5, PR-09). Turns are buffered in RAM only — whether utterances are
 * persisted is a separate opt-in. Runs at session end and periodically.
 */
export class SessionSummarizer {
  private buffer: BufferedTurn[] = [];
  private seq = 0;
  /** Bumped by clear() so a summary started before a wipe cannot write afterwards. */
  private generation = 0;
  private inflight: Promise<string[]> | null = null;
  private abort: AbortController | null = null;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: SessionSummarizerDeps) {
    this.maxTurns = deps.maxTurns ?? 200;
    this.timeoutMs = deps.timeoutMs ?? 60_000;
  }

  record(turn: Turn): void {
    if (!turn.text.trim()) return;
    this.buffer.push({ ...turn, seq: ++this.seq });
    if (this.buffer.length > this.maxTurns) this.buffer.splice(0, this.buffer.length - this.maxTurns);
  }

  get pendingTurns(): number {
    return this.buffer.length;
  }

  get busy(): boolean {
    return this.inflight !== null;
  }

  /**
   * Summarize what has been buffered since the last successful summary.
   * Returns the facts written. Never throws; offline / failure keeps the
   * buffer for the next attempt.
   */
  summarize(opts: { minUserTurns?: number; idleSince?: number } = {}): Promise<string[]> {
    if (this.inflight) return this.inflight;
    if (!this.deps.enabled()) {
      // Nothing may be remembered, so there is no reason to keep the text either.
      this.buffer = [];
      return Promise.resolve([]);
    }
    const userTurns = this.buffer.filter((t) => t.role === 'user').length;
    if (userTurns < (opts.minUserTurns ?? 2) || !this.deps.isOnline()) return Promise.resolve([]);
    // Periodic runs wait for a lull: Ollama serves one request at a time, and
    // a summary must never delay Navi's reply to the user.
    const lastAt = this.buffer[this.buffer.length - 1]?.at ?? 0;
    if (opts.idleSince !== undefined && lastAt > opts.idleSince) return Promise.resolve([]);

    const batch = [...this.buffer];
    const run = this.run(batch).finally(() => {
      this.inflight = null;
      this.abort = null;
    });
    this.inflight = run;
    return run;
  }

  /** Cancel an in-flight summary (app is quitting and cannot wait any longer). */
  cancel(): void {
    this.abort?.abort();
  }

  /** The user wiped their memory: drop buffered turns and discard any in-flight result. */
  clear(): void {
    this.buffer = [];
    this.generation++;
    this.cancel();
  }

  private async run(batch: BufferedTurn[]): Promise<string[]> {
    const abort = new AbortController();
    this.abort = abort;
    const generation = this.generation;
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const raw = await this.deps.chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: formatTranscript(batch) },
        ],
        abort.signal,
      );
      const facts = parseSummaryFacts(raw);
      // persistMemory may have been switched off (or memory wiped) while the model was thinking.
      if (!this.deps.enabled() || generation !== this.generation) return [];
      for (const f of facts) this.deps.write(f);
      const last = batch[batch.length - 1]?.seq ?? 0;
      this.buffer = this.buffer.filter((t) => t.seq > last);
      return facts;
    } catch (err) {
      if (!abort.signal.aborted) console.warn('[memory] session summary failed:', err instanceof Error ? err.message : err);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

/** "ユーザー: …" / "ナビ: …" lines, newest kept when over budget. */
export function formatTranscript(turns: Turn[]): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const line = `${t.role === 'user' ? 'ユーザー' : 'ナビ'}: ${redactSecrets(t.text.replace(/\s+/g, ' ').trim()).text}`;
    if (size + line.length > TRANSCRIPT_MAX_CHARS && lines.length > 0) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  return `以下が今回の会話です。\n\n${lines.join('\n')}`;
}

/**
 * Accepts {"facts":[...]}, a bare array, code fences, or prose around the
 * JSON. Anything unusable yields []. Facts that contained a secret are
 * dropped rather than stored half-masked.
 */
export function parseSummaryFacts(raw: string): string[] {
  const value = extractJson(raw);
  let list: unknown[] = [];
  if (Array.isArray(value)) list = value;
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const arr = obj.facts ?? obj.memories ?? obj.items ?? Object.values(obj).find(Array.isArray);
    if (Array.isArray(arr)) list = arr;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const fact = item
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:[-*・•]|\d+[.)．])\s*/, '')
      .replace(/^[「『"]+|[」』"]+$/g, '')
      .trim();
    if (fact.length < FACT_MIN_LEN || fact.length > FACT_MAX_LEN) continue;
    if (redactSecrets(fact).redacted) continue;
    if (seen.has(fact)) continue;
    seen.add(fact);
    out.push(fact);
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

function extractJson(raw: string): unknown {
  const text = String(raw ?? '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(text);
  if (direct !== undefined) return direct;
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) {
      const inner = tryParse(text.slice(start, end + 1));
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}
