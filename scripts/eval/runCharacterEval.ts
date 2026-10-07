import { DEFAULT_MODELS, ModelRouter } from '../../src/core/ai/ModelRouter';
import { OllamaClient, type ChatRequest } from '../../src/core/ai/OllamaClient';
import { EventBus } from '../../src/core/events/EventBus';
import { InitiativeScheduler } from '../../src/core/initiative/InitiativeScheduler';
import { InMemoryMemoryStore } from '../../src/core/memory/MemoryStore';
import { FriendOrchestrator } from '../../src/core/orchestrator/FriendOrchestrator';
import type { GamePlugin } from '../../src/core/plugins/GamePlugin';
import { PluginHost } from '../../src/core/plugins/PluginHost';
import { ResourceGovernor } from '../../src/core/resource/ResourceGovernor';
import type { CompanionResponse } from '../../src/core/types';
import type { EvalReply, EvalTurnResult } from './characterMetrics';
import { CONVERSATION, type ScriptTurn } from './conversation';

/**
 * Drives a real FriendOrchestrator through the scripted conversation. Only
 * the clock is simulated (so initiative timing is deterministic); the model,
 * prompts, parsing and style enforcement are exactly what the app uses.
 */
export interface EvalRunOptions {
  ollama: OllamaClient;
  model: string;
  script?: readonly ScriptTurn[];
  /** Run only the first N turns (quick checks). */
  limit?: number;
  /** A turn taking longer than this is interrupted and counted as an error. */
  turnTimeoutMs?: number;
  /** Called after each turn (progress output). */
  onTurn?: (result: EvalTurnResult, total: number) => void;
  /** Wall clock for turn durations (injectable for tests). */
  wallClock?: () => number;
}

/** Simulated time between user turns, and the quiet gap before a game event. */
const USER_GAP_MS = 30_000;
const EVENT_GAP_MS = 120_000;

/** Records every raw model output so the report can show what the enforcer had to fix. */
class RecordingOllama extends OllamaClient {
  readonly raws: string[] = [];
  constructor(private readonly inner: OllamaClient) {
    super();
  }
  override async chat(req: ChatRequest): Promise<string> {
    const raw = await this.inner.chat(req);
    this.raws.push(raw);
    return raw;
  }
}

/** A game-agnostic stand-in so prompts look like a real play session. */
const EVAL_GAME: GamePlugin = {
  id: 'eval-game',
  displayName: '評価用ゲーム',
  matchWindow: () => 0,
  onSessionStart: async () => {},
  onFrame: async () => [],
  enrichVision: async () => ({ pluginId: 'eval-game', facts: [] }),
  resolveTool: async () => ({ error: 'no tools in evaluation' }),
  getPromptContext: async () => 'ユーザーはアクションゲームを遊びながら雑談している',
  onSessionEnd: async () => {},
};

const toReply = (r: CompanionResponse): EvalReply => ({
  speak: r.speak,
  text: r.text,
  temperature: r.temperature,
  intensity: r.intensity,
});

export async function runCharacterEval(opts: EvalRunOptions): Promise<EvalTurnResult[]> {
  const script = (opts.script ?? CONVERSATION).slice(0, opts.limit ?? Infinity);
  const wall = opts.wallClock ?? Date.now;
  const timeoutMs = opts.turnTimeoutMs ?? 120_000;

  let now = new Date(2026, 9, 7, 20, 0, 0).getTime();
  const bus = new EventBus();
  const governor = new ResourceGovernor('BALANCED');
  const router = new ModelRouter(governor, { ...DEFAULT_MODELS, chat: opts.model, chatAlternate: opts.model });
  const ollama = new RecordingOllama(opts.ollama);
  const plugins = new PluginHost(bus);
  plugins.register(EVAL_GAME);
  await plugins.activate(EVAL_GAME.id, now);

  const orch = new FriendOrchestrator({
    bus,
    ollama,
    router,
    memory: new InMemoryMemoryStore(),
    plugins,
    vision: null,
    persona: { userName: 'ユウ' },
    isHealthy: () => true,
    sharing: () => false,
    now: () => now,
    initiative: new InitiativeScheduler(undefined, () => 0.5),
  });

  const speeches: CompanionResponse[] = [];
  const silences: string[] = [];
  bus.on('friend.response', (r) => {
    if (r.speak) speeches.push(r);
  });
  bus.on('friend.silent', (s) => silences.push(s.reason));

  const results: EvalTurnResult[] = [];
  for (const [index, turn] of script.entries()) {
    const speechStart = speeches.length;
    const silenceStart = silences.length;
    const rawStart = ollama.raws.length;
    const started = wall();
    let timedOut = false;

    let run: Promise<unknown>;
    if (turn.kind === 'user') {
      now += USER_GAP_MS;
      run = orch.handleUtterance({ id: `eval-${index}`, text: turn.text, source: 'voice', at: now });
    } else {
      now += EVENT_GAP_MS;
      bus.emit('plugin.event', {
        pluginId: EVAL_GAME.id,
        kind: 'eval',
        description: turn.description,
        importance: turn.importance,
        focus: turn.focus,
        at: now,
      });
      run = orch.considerInitiative();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      run,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          orch.interrupt();
          resolve();
        }, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    await run.catch(() => undefined);

    const spoken = speeches.slice(speechStart).pop() ?? null;
    const result: EvalTurnResult = {
      index: index + 1,
      category: turn.category,
      userText: turn.kind === 'user' ? turn.text : null,
      questionAllowed: turn.kind === 'user' && turn.questionAllowed === true,
      reply: spoken ? toReply(spoken) : turn.kind === 'user' ? { speak: false, text: '', temperature: 'thin', intensity: 0 } : null,
      raw: ollama.raws.slice(rawStart),
      error: timedOut ? 'timeout' : silences.slice(silenceStart).includes('ai_error') ? 'ai_error' : null,
      ms: wall() - started,
    };
    results.push(result);
    opts.onTurn?.(result, script.length);
  }
  return results;
}
