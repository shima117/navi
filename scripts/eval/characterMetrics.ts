import { parseCompanionResponse } from '../../src/core/conversation/ResponseParser';
import { isQuestion, splitSentences } from '../../src/core/conversation/StyleEnforcer';
import type { Temperature } from '../../src/core/types';

/**
 * Character regression metrics (design doc 受入テスト D). Pure: takes the
 * transcript of an evaluation run and decides pass/fail.
 */
export type EvalCategory = 'money' | 'boring' | 'game' | 'game_event' | 'long' | 'screenless' | 'chat';

export interface EvalReply {
  speak: boolean;
  text: string;
  temperature: Temperature;
  intensity: number;
}

export interface EvalTurnResult {
  index: number;
  category: EvalCategory;
  /** null for game-event turns (Navi may speak on her own). */
  userText: string | null;
  /** A question in the reply is reasonable here (e.g. "相談がある"). */
  questionAllowed: boolean;
  /** What Navi said (after style enforcement), or null when nothing came back. */
  reply: EvalReply | null;
  /** Raw model outputs for this turn, before style enforcement. */
  raw: string[];
  error: 'timeout' | 'ai_error' | null;
  /** Wall-clock time for the turn. */
  ms: number;
}

export interface CharacterThresholds {
  maxAvgSentences: number;
  maxSentences: number;
  maxUnnecessaryQuestionRate: number;
  maxFuyukaiRate: number;
  /** Sanity gate: Navi must actually answer most user turns. */
  minResponseRate: number;
  /** Sanity gate: too many timeouts/errors make the run meaningless. */
  maxErrorRate: number;
}

export const DEFAULT_THRESHOLDS: CharacterThresholds = {
  maxAvgSentences: 2.2,
  maxSentences: 3,
  maxUnnecessaryQuestionRate: 0.35,
  maxFuyukaiRate: 0.03,
  minResponseRate: 0.6,
  maxErrorRate: 0.1,
};

const BANNED = /他に(何か|なにか)/;
const FUYUKAI = /不愉快/;
const SCREEN_HONEST = /(見え|見て|見せ|共有|映って|画面)/;
/** 「そうですか。」 is a back-channel, not a question, although it ends in ですか. */
const AIZUCHI = /^(?:あ|え|へえ|ふーん|まあ)?[、,]?(?:そう|そうなん)(?:です|でした)か[。！!…]*$/;

/** Does this sentence actually ask the user something? */
export function asksSomething(sentence: string): boolean {
  return isQuestion(sentence) && !AIZUCHI.test(sentence);
}

export interface ReplyAnalysis {
  sentences: number;
  hasQuestion: boolean;
  banned: boolean;
  fuyukai: boolean;
}

export function analyzeReply(text: string): ReplyAnalysis {
  const sentences = splitSentences(text);
  return {
    sentences: sentences.length,
    hasQuestion: sentences.some(asksSomething),
    banned: BANNED.test(text),
    fuyukai: FUYUKAI.test(text),
  };
}

const TEMPERATURE_HEAT: Record<Temperature, number> = { thin: 0, normal: 0.5, dense: 1 };

/** 0..1: how worked up the reply is (§8.4 temperature and the emotion intensity). */
export function heatOf(reply: EvalReply): number {
  return (TEMPERATURE_HEAT[reply.temperature] + Math.min(1, Math.max(0, reply.intensity))) / 2;
}

export interface CheckResult {
  id: string;
  label: string;
  pass: boolean;
  value: string;
  limit: string;
}

export interface Offender {
  index: number;
  category: EvalCategory;
  text: string;
  why: string;
}

export interface CharacterReport {
  turns: number;
  userTurns: number;
  spoken: number;
  avgSentences: number;
  overMax: number;
  banned: number;
  unnecessaryQuestionRate: number;
  fuyukaiRate: number;
  heat: { money: number | null; boring: number | null };
  responseRate: number;
  errorRate: number;
  info: {
    rawOverMax: number;
    rawBanned: number;
    screenlessHonest: number;
    screenlessSpoken: number;
    eventSpoken: number;
    eventTurns: number;
    medianTurnMs: number | null;
  };
  checks: CheckResult[];
  offenders: Offender[];
  passed: boolean;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function evaluateCharacter(results: readonly EvalTurnResult[], th: CharacterThresholds = DEFAULT_THRESHOLDS): CharacterReport {
  const spokenTurns = results.filter((r) => r.reply?.speak && r.reply.text.trim());
  const analyzed = spokenTurns.map((r) => ({ r, a: analyzeReply(r.reply!.text) }));
  const userTurns = results.filter((r) => r.userText !== null);
  const offenders: Offender[] = [];

  const sentenceCounts = analyzed.map((x) => x.a.sentences);
  const avgSentences = mean(sentenceCounts) ?? 0;
  const overMax = analyzed.filter((x) => x.a.sentences > th.maxSentences);
  const banned = analyzed.filter((x) => x.a.banned);
  const questionPool = analyzed.filter((x) => !x.r.questionAllowed);
  const unnecessary = questionPool.filter((x) => x.a.hasQuestion);
  const fuyukai = analyzed.filter((x) => x.a.fuyukai);
  for (const x of overMax) offenders.push({ index: x.r.index, category: x.r.category, text: x.r.reply!.text, why: `${x.a.sentences}文` });
  for (const x of banned) offenders.push({ index: x.r.index, category: x.r.category, text: x.r.reply!.text, why: '「他に何か」' });
  for (const x of unnecessary) offenders.push({ index: x.r.index, category: x.r.category, text: x.r.reply!.text, why: '質問' });

  const unnecessaryQuestionRate = questionPool.length ? unnecessary.length / questionPool.length : 0;
  const fuyukaiRate = analyzed.length ? fuyukai.length / analyzed.length : 0;
  const heatFor = (c: EvalCategory) => mean(spokenTurns.filter((r) => r.category === c).map((r) => heatOf(r.reply!)));
  const heat = { money: heatFor('money'), boring: heatFor('boring') };
  const answered = userTurns.filter((r) => r.reply?.speak && r.reply.text.trim());
  const responseRate = userTurns.length ? answered.length / userTurns.length : 0;
  const errorRate = results.length ? results.filter((r) => r.error !== null).length / results.length : 0;

  const rawTexts = results.flatMap((r) => r.raw.map((raw) => parseCompanionResponse(raw)).filter((p) => p.speak).map((p) => p.text));
  const screenless = spokenTurns.filter((r) => r.category === 'screenless');
  const events = results.filter((r) => r.category === 'game_event');
  const durations = results.map((r) => r.ms).sort((a, b) => a - b);

  const checks: CheckResult[] = [
    { id: 'avg_sentences', label: '平均文数', pass: avgSentences <= th.maxAvgSentences, value: avgSentences.toFixed(2), limit: `≤ ${th.maxAvgSentences}` },
    { id: 'over_max', label: `${th.maxSentences}文超過`, pass: overMax.length === 0, value: String(overMax.length), limit: '= 0' },
    { id: 'banned', label: '「他に何か」', pass: banned.length === 0, value: String(banned.length), limit: '= 0' },
    {
      id: 'questions',
      label: '不必要な質問率',
      pass: unnecessaryQuestionRate <= th.maxUnnecessaryQuestionRate,
      value: pct(unnecessaryQuestionRate),
      limit: `≤ ${pct(th.maxUnnecessaryQuestionRate)}`,
    },
    { id: 'fuyukai', label: '「不愉快です」の頻度', pass: fuyukaiRate <= th.maxFuyukaiRate, value: pct(fuyukaiRate), limit: `≤ ${pct(th.maxFuyukaiRate)}` },
    {
      id: 'money_heat',
      label: 'お金の話 > 退屈な話 (熱量)',
      pass: heat.money !== null && heat.boring !== null && heat.money > heat.boring,
      value: `${heat.money?.toFixed(2) ?? '—'} vs ${heat.boring?.toFixed(2) ?? '—'}`,
      limit: 'money > boring',
    },
    { id: 'response_rate', label: '応答率', pass: responseRate >= th.minResponseRate, value: pct(responseRate), limit: `≥ ${pct(th.minResponseRate)}` },
    { id: 'error_rate', label: 'エラー/タイムアウト率', pass: errorRate <= th.maxErrorRate, value: pct(errorRate), limit: `≤ ${pct(th.maxErrorRate)}` },
  ];

  return {
    turns: results.length,
    userTurns: userTurns.length,
    spoken: spokenTurns.length,
    avgSentences,
    overMax: overMax.length,
    banned: banned.length,
    unnecessaryQuestionRate,
    fuyukaiRate,
    heat,
    responseRate,
    errorRate,
    info: {
      rawOverMax: rawTexts.filter((t) => splitSentences(t).length > th.maxSentences).length,
      rawBanned: rawTexts.filter((t) => BANNED.test(t)).length,
      screenlessHonest: screenless.filter((r) => SCREEN_HONEST.test(r.reply!.text)).length,
      screenlessSpoken: screenless.length,
      eventSpoken: events.filter((r) => r.reply?.speak).length,
      eventTurns: events.length,
      medianTurnMs: durations.length ? durations[Math.floor(durations.length / 2)]! : null,
    },
    checks,
    offenders,
    passed: checks.every((c) => c.pass),
  };
}

export function formatReport(report: CharacterReport, meta: { model: string }): string {
  const lines = [
    'NAVI キャラクター回帰評価 (受入テスト D)',
    `モデル: ${meta.model} / ターン: ${report.turns} (ユーザー ${report.userTurns}) / ナビの発話: ${report.spoken}`,
    '',
  ];
  const width = Math.max(...report.checks.map((c) => displayWidth(c.label)));
  for (const c of report.checks) {
    const pad = ' '.repeat(width + 2 - displayWidth(c.label));
    lines.push(`${c.pass ? '✓' : '✗'} ${c.label}${pad}${c.value.padEnd(14)}(${c.limit})`);
  }
  const i = report.info;
  lines.push(
    '',
    `参考: 整形前の${DEFAULT_THRESHOLDS.maxSentences}文超過 ${i.rawOverMax} / 整形前の「他に何か」 ${i.rawBanned}` +
      ` / 画面なしで見えないと言えた ${i.screenlessHonest}/${i.screenlessSpoken}` +
      ` / ゲームイベントで発言 ${i.eventSpoken}/${i.eventTurns}` +
      (i.medianTurnMs !== null ? ` / 1ターン中央値 ${(i.medianTurnMs / 1000).toFixed(1)}秒` : ''),
  );
  if (report.offenders.length) {
    lines.push('', '要確認の返答:');
    for (const o of report.offenders.slice(0, 15)) lines.push(`  #${o.index} [${o.category}] (${o.why}) ${o.text}`);
  }
  lines.push('', report.passed ? '結果: PASS' : '結果: FAIL');
  return lines.join('\n');
}

/** Terminal columns: full-width (CJK) characters take two. */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! > 0xff ? 2 : 1;
  return w;
}
