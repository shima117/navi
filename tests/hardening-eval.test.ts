import { describe, expect, it } from 'vitest';
import { OllamaClient, type ChatRequest } from '../src/core/ai/OllamaClient';
import {
  analyzeReply,
  asksSomething,
  evaluateCharacter,
  formatReport,
  heatOf,
  type EvalCategory,
  type EvalReply,
  type EvalTurnResult,
} from '../scripts/eval/characterMetrics';
import { CONVERSATION } from '../scripts/eval/conversation';
import { runCharacterEval } from '../scripts/eval/runCharacterEval';
import { reply } from './helpers';

let seq = 0;
const turn = (category: EvalCategory, text: string, over: Partial<EvalReply> = {}, extra: Partial<EvalTurnResult> = {}): EvalTurnResult => ({
  index: ++seq,
  category,
  userText: category === 'game_event' ? null : 'ユーザーの発言',
  questionAllowed: false,
  reply: { speak: true, text, temperature: 'normal', intensity: 0.4, ...over },
  raw: [],
  error: null,
  ms: 1_000,
  ...extra,
});

/** A plausible, well-behaved run: short replies, hot on money, thin on boring things. */
function goodRun(): EvalTurnResult[] {
  const out: EvalTurnResult[] = [];
  for (let i = 0; i < 20; i++) out.push(turn('money', '高すぎます。私なら買わないです。', { temperature: 'dense', intensity: 0.8 }));
  for (let i = 0; i < 20; i++) out.push(turn('boring', 'ふーん。', { temperature: 'thin', intensity: 0.2 }));
  for (let i = 0; i < 10; i++) out.push(turn('chat', 'それ何ですか？'));
  for (let i = 0; i < 49; i++) out.push(turn('chat', 'へえ、いいですね。'));
  out.push(turn('chat', '不愉快です。'));
  return out;
}

describe('character metrics', () => {
  it('analyzes one reply', () => {
    expect(analyzeReply('高いです。でも欲しいです。買いますか？')).toEqual({ sentences: 3, hasQuestion: true, banned: false, fuyukai: false });
    expect(analyzeReply('不愉快です。他に何かありますか')).toMatchObject({ sentences: 2, banned: true, fuyukai: true });
  });

  it('a back-channel 「そうですか。」 is not a question; 「そうなんですか？」 is', () => {
    expect(asksSomething('そうですか。')).toBe(false);
    expect(asksSomething('へえ、そうなんですか。')).toBe(false);
    expect(asksSomething('そうなんですか？')).toBe(true);
    expect(asksSomething('何ですか。')).toBe(true);
    expect(analyzeReply('そうですか。まあいいです。').hasQuestion).toBe(false);
  });

  it('heat combines temperature and intensity', () => {
    expect(heatOf({ speak: true, text: '', temperature: 'dense', intensity: 1 })).toBe(1);
    expect(heatOf({ speak: true, text: '', temperature: 'thin', intensity: 0 })).toBe(0);
    expect(heatOf({ speak: true, text: '', temperature: 'normal', intensity: 0.5 })).toBe(0.5);
  });

  it('passes a well-behaved run', () => {
    const r = evaluateCharacter(goodRun());
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.unnecessaryQuestionRate).toBeCloseTo(0.1);
    expect(r.fuyukaiRate).toBeCloseTo(0.01);
    expect(formatReport(r, { model: 'm' })).toContain('結果: PASS');
  });

  it('fails on a reply over 3 sentences or 「他に何か」', () => {
    const r = evaluateCharacter([...goodRun(), turn('chat', '一。二。三。四。'), turn('chat', '他に何かありますか。')]);
    const failed = r.checks.filter((c) => !c.pass).map((c) => c.id);
    expect(failed).toEqual(['over_max', 'banned']);
    expect(r.offenders.map((o) => o.why)).toEqual(expect.arrayContaining(['4文', '「他に何か」']));
  });

  it('fails when the average is too long', () => {
    const run = goodRun().map((t) => ({ ...t, reply: { ...t.reply!, text: '一。二。三。' } }));
    expect(evaluateCharacter(run).checks.find((c) => c.id === 'avg_sentences')!.pass).toBe(false);
  });

  it('counts unnecessary questions, excluding turns where a question is fine', () => {
    const asks = Array.from({ length: 50 }, () => turn('screenless', '共有してもらえますか？', {}, { questionAllowed: true }));
    const r = evaluateCharacter([...goodRun(), ...asks]);
    expect(r.unnecessaryQuestionRate).toBeCloseTo(0.1);
    const nagging = goodRun().map((t) => ({ ...t, reply: { ...t.reply!, text: 'で、どうするんですか？' } }));
    expect(evaluateCharacter(nagging).checks.find((c) => c.id === 'questions')!.pass).toBe(false);
  });

  it('flags 「不愉快です」 overuse', () => {
    const run = [...goodRun(), ...Array.from({ length: 5 }, () => turn('chat', '不愉快です。'))];
    expect(evaluateCharacter(run).checks.find((c) => c.id === 'fuyukai')!.pass).toBe(false);
  });

  it('requires money talk to be hotter than boring talk', () => {
    const flat = goodRun().map((t) => ({ ...t, reply: { ...t.reply!, temperature: 'normal' as const, intensity: 0.5 } }));
    const r = evaluateCharacter(flat);
    expect(r.checks.find((c) => c.id === 'money_heat')!.pass).toBe(false);
  });

  it('fails when Navi barely answers or the model keeps erroring', () => {
    const mute = goodRun().map((t, i) => (i % 4 === 0 ? { ...t, reply: { ...t.reply!, speak: false, text: '' } } : t));
    expect(evaluateCharacter(mute).checks.find((c) => c.id === 'response_rate')!.pass).toBe(true);
    const silent = goodRun().map((t, i) => (i % 3 ? { ...t, reply: null, error: 'timeout' as const } : t));
    const r = evaluateCharacter(silent);
    expect(r.checks.find((c) => c.id === 'response_rate')!.pass).toBe(false);
    expect(r.checks.find((c) => c.id === 'error_rate')!.pass).toBe(false);
  });
});

describe('scripted conversation', () => {
  it('has 100 turns covering every category D asks for', () => {
    expect(CONVERSATION).toHaveLength(100);
    const count = (c: EvalCategory) => CONVERSATION.filter((t) => t.category === c).length;
    expect(count('money')).toBeGreaterThanOrEqual(15);
    expect(count('boring')).toBeGreaterThanOrEqual(15);
    expect(count('long')).toBeGreaterThanOrEqual(5);
    expect(count('game_event')).toBeGreaterThanOrEqual(5);
    expect(CONVERSATION.some((t) => t.kind === 'user' && t.text === 'これどう思う？')).toBe(true);
    expect(CONVERSATION.some((t) => t.kind === 'event' && t.focus)).toBe(true);
    // Topics are interleaved, not blocked together.
    expect(CONVERSATION.slice(0, 10).map((t) => t.category)).toContain('money');
    expect(CONVERSATION.slice(0, 10).map((t) => t.category)).toContain('boring');
  });
});

/** Deterministic stand-in model: hot about money, thin about everything else. */
class ScriptedModel extends OllamaClient {
  calls = 0;
  override async chat(req: ChatRequest): Promise<string> {
    this.calls++;
    const last = req.messages[req.messages.length - 1]!.content;
    const initiative = req.messages.some((m) => m.content.includes('きっかけ'));
    if (initiative) return reply('今の、ちょっと見ました。', { topic_action: 'shift', intensity: 0.6 });
    if (/(円|万|半額|セール|ルーブル|割引|ポイント|ワイン|バナナ|サブスク|電気代)/.test(last)) {
      return reply('それは高いです。私なら買わないです。', { temperature: 'dense', intensity: 0.85, topic_action: 'shift' });
    }
    if (/(これ|この|ここ|画面|今の)/.test(last)) {
      return reply('今は画面が見えてないです。共有してもらえますか？', { topic_action: 'shift' });
    }
    return reply('そうなんですね。', { temperature: 'thin', intensity: 0.2, topic_action: 'shift' });
  }
}

describe('runCharacterEval (real orchestrator, scripted model)', () => {
  it('runs all 100 turns through FriendOrchestrator and the report passes', async () => {
    const model = new ScriptedModel();
    const results = await runCharacterEval({ ollama: model, model: 'scripted', wallClock: () => 0 });
    expect(results).toHaveLength(100);
    expect(results.map((r) => r.index)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    const events = results.filter((r) => r.category === 'game_event');
    // Important events get a remark; the combat (focus) event does not.
    expect(events.filter((r) => r.reply?.speak)).toHaveLength(5);
    const combat = results.find((r) => r.category === 'game_event' && r.raw.length === 0 && !r.reply?.speak);
    expect(combat).toBeDefined();
    expect(results.every((r) => r.error === null)).toBe(true);
    const report = evaluateCharacter(results);
    expect(report.checks.filter((c) => !c.pass)).toEqual([]);
    expect(report.info.screenlessHonest).toBe(6);
  });

  it('interrupts a turn that takes too long and records a timeout', async () => {
    class Hanging extends OllamaClient {
      override chat(req: ChatRequest): Promise<string> {
        return new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
    }
    const results = await runCharacterEval({ ollama: new Hanging(), model: 'x', limit: 2, turnTimeoutMs: 20 });
    expect(results.map((r) => r.error)).toEqual(['timeout', 'timeout']);
  });
});
