/**
 * Character regression harness (design doc 受入テスト D).
 *
 *   npm run eval:character -- [--model dolphin3:8b] [--turns 100] [--verbose] [--json report.json]
 *
 * Drives the real FriendOrchestrator against the local Ollama (127.0.0.1:11434)
 * through a scripted 100-turn conversation and checks the character stays
 * intact. Exit 0 = pass (or skipped: Ollama / model not available), 1 = fail,
 * 2 = the harness itself broke.
 */
import { writeFileSync } from 'node:fs';
import { DEFAULT_MODELS } from '../src/core/ai/ModelRouter';
import { OllamaClient } from '../src/core/ai/OllamaClient';
import { evaluateCharacter, formatReport, type EvalTurnResult } from './eval/characterMetrics';
import { runCharacterEval } from './eval/runCharacterEval';

const OLLAMA_URL = 'http://127.0.0.1:11434';

interface Args {
  model: string;
  turns: number | undefined;
  verbose: boolean;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { model: process.env.NAVI_EVAL_MODEL ?? DEFAULT_MODELS.chat, turns: undefined, verbose: false, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--model') args.model = value();
    else if (a === '--turns') args.turns = Math.max(1, Number.parseInt(value(), 10) || 1);
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--json') args.json = value();
    else throw new Error(`unknown option ${a}`);
  }
  return args;
}

/** Installed model names, or null if the list could not be read. */
async function installedModels(): Promise<string[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    if (!Array.isArray(body.models)) return null;
    return body.models.flatMap((m) => [m.name, m.model]).filter((n): n is string => typeof n === 'string');
  } catch {
    return null;
  }
}

function printTurn(r: EvalTurnResult, total: number, verbose: boolean): void {
  if (!verbose) {
    if (r.index % 10 === 0 || r.index === total) process.stderr.write(`  ${r.index}/${total} turns\n`);
    return;
  }
  const said = r.reply?.speak ? `${r.reply.text} [${r.reply.temperature} ${r.reply.intensity.toFixed(2)}]` : '(黙る)';
  const who = r.userText ?? '(ゲームイベント)';
  process.stderr.write(`#${r.index} [${r.category}] ${who}\n    → ${said}${r.error ? ` !${r.error}` : ''}\n`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const ollama = new OllamaClient(OLLAMA_URL);
  if (!(await ollama.ping(AbortSignal.timeout(3_000)))) {
    console.log(`SKIP: Ollama (${OLLAMA_URL}) に接続できないため、キャラクター評価をスキップしました。`);
    return 0;
  }
  const models = await installedModels();
  if (models && !models.some((m) => m === args.model || m === `${args.model}:latest`)) {
    console.log(`SKIP: モデル ${args.model} が見つかりません (ollama pull ${args.model})。キャラクター評価をスキップしました。`);
    return 0;
  }

  console.error(`評価中: ${args.model} (${args.turns ?? 100} ターン) …`);
  const results = await runCharacterEval({
    ollama,
    model: args.model,
    limit: args.turns,
    onTurn: (r, total) => printTurn(r, total, args.verbose),
  });
  const report = evaluateCharacter(results);
  console.log(formatReport(report, { model: args.model }));
  if (args.json) {
    writeFileSync(args.json, `${JSON.stringify({ model: args.model, report, results }, null, 2)}\n`);
    console.log(`詳細: ${args.json}`);
  }
  return report.passed ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('[eval:character] harness error:', err);
    process.exit(2);
  },
);
