import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/core/ai/OllamaClient';
import {
  formatTranscript,
  parseSummaryFacts,
  SessionSummarizer,
  type SessionSummarizerDeps,
} from '../src/core/memory/SessionSummarizer';
import { makeStore, T0 } from './memory-helpers';

afterEach(() => vi.restoreAllMocks());

function setup(replies: Array<string | Error>, deps: Partial<SessionSummarizerDeps> = {}) {
  const calls: ChatMessage[][] = [];
  const written: string[] = [];
  const state = { online: true, enabled: true };
  const s = new SessionSummarizer({
    chat: async (messages) => {
      calls.push(messages);
      const next = replies.shift();
      if (next === undefined) throw new Error('no scripted reply');
      if (next instanceof Error) throw next;
      return next;
    },
    isOnline: () => state.online,
    enabled: () => state.enabled,
    write: (f) => written.push(f),
    ...deps,
  });
  return { s, calls, written, state };
}

function talk(s: SessionSummarizer, n = 3) {
  for (let i = 0; i < n; i++) {
    s.record({ role: 'user', text: `タルコフの話 ${i}`, at: T0 + i });
    s.record({ role: 'navi', text: 'そうですか', at: T0 + i });
  }
}

describe('parseSummaryFacts', () => {
  it('reads {"facts": [...]}, bare arrays, fences and prose', () => {
    expect(parseSummaryFacts('{"facts":["ユーザーはサイドストーリーより対人戦が好き"]}')).toEqual([
      'ユーザーはサイドストーリーより対人戦が好き',
    ]);
    expect(parseSummaryFacts('["ユーザーは夜にゲームをする"]')).toEqual(['ユーザーは夜にゲームをする']);
    expect(parseSummaryFacts('```json\n{"memories": ["- 「ユーザーは辛いものが苦手」"]}\n```')).toEqual([
      'ユーザーは辛いものが苦手',
    ]);
    expect(parseSummaryFacts('はい、こちらです: {"facts": ["1. ユーザーはタルコフが好き"]} 以上')).toEqual([
      'ユーザーはタルコフが好き',
    ]);
  });

  it('tolerates garbage', () => {
    for (const raw of ['', 'not json', '{"facts": "nope"}', '{"facts": [1, null, {}]}', '[[[', 'null']) {
      expect(parseSummaryFacts(raw)).toEqual([]);
    }
  });

  it('keeps at most five short, unique facts and drops secrets', () => {
    const facts = [
      'ユーザーはタルコフが好き',
      'ユーザーはタルコフが好き',
      'ok',
      'あ'.repeat(200),
      'ユーザーのAPIキーは sk-abcdefghijklmnopqrstu',
      'ユーザーは夜にゲームをする',
      'ユーザーは辛いものが苦手',
      'ユーザーはFPSが得意',
      'ユーザーは猫を飼っている',
      'ユーザーは眼鏡をかけている',
    ];
    expect(parseSummaryFacts(JSON.stringify({ facts }))).toEqual([
      'ユーザーはタルコフが好き',
      'ユーザーは夜にゲームをする',
      'ユーザーは辛いものが苦手',
      'ユーザーはFPSが得意',
      'ユーザーは猫を飼っている',
    ]);
  });
});

describe('formatTranscript', () => {
  it('labels speakers, masks secrets and keeps the newest turns within budget', () => {
    const out = formatTranscript([
      { role: 'user', text: 'パスワードは hunter22 だよ', at: 0 },
      { role: 'navi', text: '覚えません', at: 1 },
    ]);
    expect(out).toContain('ユーザー: パスワードは [伏せ字] だよ');
    expect(out).toContain('ナビ: 覚えません');
    const long = formatTranscript(Array.from({ length: 500 }, (_, i) => ({ role: 'user' as const, text: `発言${i} ${'あ'.repeat(40)}`, at: i })));
    expect(long.length).toBeLessThan(6200);
    expect(long).toContain('発言499');
    expect(long).not.toContain('発言0 ');
  });
});

describe('SessionSummarizer', () => {
  it('writes the parsed facts and consumes the buffer', async () => {
    const { s, written, calls } = setup(['{"facts":["ユーザーはサイドストーリーより対人戦が好き"]}']);
    talk(s);
    expect(await s.summarize()).toEqual(['ユーザーはサイドストーリーより対人戦が好き']);
    expect(written).toEqual(['ユーザーはサイドストーリーより対人戦が好き']);
    expect(calls[0]![1]!.content).toContain('ユーザー: タルコフの話 0');
    expect(s.pendingTurns).toBe(0);
  });

  it('skips silently when the chat model is offline and retries later', async () => {
    const { s, calls, written, state } = setup(['{"facts":["ユーザーはタルコフが好き"]}']);
    talk(s);
    state.online = false;
    expect(await s.summarize()).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(s.pendingTurns).toBe(6);
    state.online = true;
    await s.summarize();
    expect(written).toEqual(['ユーザーはタルコフが好き']);
  });

  it('keeps the buffer when the model call fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { s, written } = setup([new Error('ECONNREFUSED'), '{"facts":["ユーザーはタルコフが好き"]}']);
    talk(s);
    expect(await s.summarize()).toEqual([]);
    expect(s.pendingTurns).toBe(6);
    expect(await s.summarize()).toEqual(['ユーザーはタルコフが好き']);
    expect(written).toHaveLength(1);
  });

  it('tolerates a garbage reply', async () => {
    const { s, written } = setup(['I am a language model']);
    talk(s);
    await expect(s.summarize()).resolves.toEqual([]);
    expect(written).toEqual([]);
  });

  it('does nothing and forgets the buffer when persistMemory is off', async () => {
    const { s, calls, state } = setup([]);
    state.enabled = false;
    talk(s);
    expect(await s.summarize()).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(s.pendingTurns).toBe(0);
  });

  it('needs enough user turns', async () => {
    const { s, calls } = setup([]);
    talk(s, 1);
    expect(await s.summarize()).toEqual([]);
    expect(await s.summarize({ minUserTurns: 6 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('periodic runs wait until the conversation has gone quiet', async () => {
    const { s, calls } = setup(['{"facts":[]}']);
    talk(s); // last turn at T0 + 2
    expect(await s.summarize({ idleSince: T0 })).toEqual([]);
    expect(calls).toHaveLength(0);
    await s.summarize({ idleSince: T0 + 10 });
    expect(calls).toHaveLength(1);
  });

  it('shares one in-flight request and keeps turns that arrive meanwhile', async () => {
    let release!: (v: string) => void;
    const { s, calls } = setup([], {
      chat: (messages) => {
        calls.push(messages);
        return new Promise((r) => (release = r));
      },
    });
    talk(s);
    const a = s.summarize();
    const b = s.summarize();
    expect(s.busy).toBe(true);
    s.record({ role: 'user', text: '新しい話', at: T0 + 100 });
    release('{"facts":["ユーザーはタルコフが好き"]}');
    expect(await a).toEqual(await b);
    expect(calls).toHaveLength(1);
    expect(s.pendingTurns).toBe(1);
    expect(s.busy).toBe(false);
  });

  it('discards an in-flight result after the memory is wiped', async () => {
    let release!: (v: string) => void;
    const written: string[] = [];
    const s = new SessionSummarizer({
      chat: () => new Promise((r) => (release = r)),
      isOnline: () => true,
      enabled: () => true,
      write: (f) => written.push(f),
    });
    talk(s);
    const p = s.summarize();
    s.clear();
    release('{"facts":["ユーザーはタルコフが好き"]}');
    expect(await p).toEqual([]);
    expect(written).toEqual([]);
  });

  it('gives up after the timeout', async () => {
    const s = new SessionSummarizer({
      chat: (_m, signal) =>
        new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      isOnline: () => true,
      enabled: () => true,
      write: () => undefined,
      timeoutMs: 10,
    });
    talk(s);
    expect(await s.summarize()).toEqual([]);
    expect(s.pendingTurns).toBe(6);
  });

  it('feeds long-term memories into the SQLite store', async () => {
    const { store } = makeStore();
    const s = new SessionSummarizer({
      chat: async () => '{"facts":["ユーザーはサイドストーリーより対人戦が好き","ユーザーは夜にゲームをする"]}',
      isOnline: () => true,
      enabled: () => true,
      write: (f) => store.write(f, 'long', T0, 'summary'),
    });
    talk(s);
    await s.summarize();
    expect(store.list('long').map((m) => [m.text, m.source]).sort()).toEqual([
      ['ユーザーは夜にゲームをする', 'summary'],
      ['ユーザーはサイドストーリーより対人戦が好き', 'summary'],
    ].sort());
  });
});
