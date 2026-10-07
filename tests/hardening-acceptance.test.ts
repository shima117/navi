import { describe, expect, it } from 'vitest';
import { ModelRouter } from '../src/core/ai/ModelRouter';
import { EventBus, type NaviEvents } from '../src/core/events/EventBus';
import { InitiativeScheduler } from '../src/core/initiative/InitiativeScheduler';
import { InMemoryMemoryStore } from '../src/core/memory/MemoryStore';
import { FriendOrchestrator } from '../src/core/orchestrator/FriendOrchestrator';
import { PluginHost } from '../src/core/plugins/PluginHost';
import { ResourceGovernor } from '../src/core/resource/ResourceGovernor';
import type { FrameSummary } from '../src/core/screen/FrameSummary';
import { VisionService, type FrameProvider } from '../src/core/screen/VisionService';
import { attachMetrics, Metrics } from '../src/core/telemetry/Metrics';
import { BargeInController, FADE_OUT_MS } from '../src/core/voice/BargeIn';
import type { ChatRequest } from '../src/core/ai/OllamaClient';
import { FakeOllama, reply } from './helpers';

/**
 * Acceptance tests at the orchestrator level (design doc 受入テスト B and C),
 * with a fake clock and a fake Ollama that would happily talk if asked.
 */
function world(opts: { random?: number; vision?: FakeOllama } = {}) {
  let now = 1_700_000_000_000;
  const bus = new EventBus();
  const chat = new FakeOllama(Array.from({ length: 50 }, () => (req: ChatRequest) => {
    now += 800; // the model takes a moment
    return reply(req.messages.some((m) => m.content.includes('きっかけ')) ? 'え、今の見ました？' : 'そうですね。');
  }));
  const governor = new ResourceGovernor('GAME_PRIORITY');
  const router = new ModelRouter(governor);
  const frames: FrameProvider = {
    getFrame: async () => ({ frameId: 'f', capturedAt: now, sourceId: 's', sourceName: 'Game', imageBase64: 'AAAA' }),
  };
  const spoken: Array<{ text: string; at: number }> = [];
  const decisions: Array<NaviEvents['metrics.initiative']> = [];
  bus.on('friend.speak', (s) => spoken.push({ text: s.text, at: now }));
  bus.on('metrics.initiative', (d) => decisions.push(d));
  const metrics = new Metrics();
  attachMetrics(bus, metrics, () => now);
  const orch = new FriendOrchestrator({
    bus,
    ollama: chat,
    router,
    memory: new InMemoryMemoryStore(),
    plugins: new PluginHost(bus),
    vision: opts.vision ? new VisionService(opts.vision, router, governor, frames) : null,
    persona: { userName: 'ユーザー' },
    isHealthy: () => true,
    sharing: () => true,
    now: () => now,
    // Production thresholds; the random term pinned (1 = worst case for staying quiet).
    initiative: new InitiativeScheduler(undefined, () => opts.random ?? 1),
  });
  const frame = (change: number): FrameSummary => ({
    frameId: `f${now}`,
    capturedAt: now,
    sourceId: 's',
    hash: `h${Math.floor(now / 1000) % 997}`,
    change,
    width: 1280,
    height: 720,
  });
  return {
    bus,
    chat,
    orch,
    spoken,
    decisions,
    metrics,
    frame,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

/** Uneventful play: small screen movement every second, initiative tick every 5 s. */
async function play(w: ReturnType<typeof world>, ms: number, perTick?: (t: number) => void): Promise<void> {
  for (let t = 0; t < ms; t += 5_000) {
    for (let s = 0; s < 5; s++) {
      w.advance(1_000);
      const change = 0.05 + ((t / 1000 + s) % 4) * 0.05; // 0.05 … 0.20, never a "big" change
      w.bus.emit('screen.frame', w.frame(change));
      if (change >= 0.15) w.bus.emit('screen.changed', w.frame(change));
    }
    perTick?.(t);
    await w.orch.considerInitiative();
  }
}

describe('Acceptance B: silence', () => {
  it('3 minutes of uneventful play produce no speech at all', async () => {
    const w = world({ random: 1 });
    await play(w, 180_000);
    expect(w.spoken).toEqual([]);
    expect(w.chat.calls).toHaveLength(0);
    expect(w.decisions).toHaveLength(36);
    expect(w.decisions.every((d) => !d.speak)).toBe(true);
    expect(w.metrics.snapshot().initiative).toMatchObject({ speak: 0, silent: 36 });
  });

  it('after a short exchange, silence alone does not make Navi talk again', async () => {
    const w = world({ random: 1 });
    await w.orch.handleUtterance({ id: 'u1', text: 'このゲーム久しぶりにやる', source: 'voice', at: w.now });
    expect(w.spoken).toHaveLength(1);
    await play(w, 180_000);
    expect(w.spoken).toHaveLength(1);
  });

  it('a high-importance game event produces one short remark', async () => {
    const w = world({ random: 0.5 });
    await play(w, 100_000);
    w.bus.emit('plugin.event', { pluginId: 'g', kind: 'boss_down', description: 'ボスを倒した', importance: 0.9, at: w.now });
    await play(w, 80_000);
    expect(w.spoken.map((s) => s.text)).toEqual(['え、今の見ました？']);
    expect(w.decisions.filter((d) => d.speak)).toHaveLength(1);
  });

  it('focus (combat) suppresses even important events', async () => {
    const w = world({ random: 1 });
    await play(w, 60_000);
    w.bus.emit('plugin.event', { pluginId: 'g', kind: 'combat', description: '戦闘開始', importance: 0.3, at: w.now, focus: true });
    w.bus.emit('plugin.event', { pluginId: 'g', kind: 'kill', description: '敵を倒した', importance: 0.9, at: w.now });
    await play(w, 120_000);
    expect(w.spoken).toEqual([]);
    expect(w.decisions.some((d) => d.reason === 'focus')).toBe(true);
  });
});

describe('Acceptance C: barge-in', () => {
  it('user speech fades Navi out within ~180 ms and the next utterance is answered', async () => {
    const w = world();
    const fades: number[] = [];
    let mouthStopped = false;
    const bargeIn = new BargeInController({
      fadeOut: (ms) => fades.push(ms),
      stopMouth: () => (mouthStopped = true),
      markInterrupted: () => w.bus.emit('voice.interrupted', { at: w.now }),
    });

    await w.orch.handleUtterance({ id: 'u1', text: '話して', source: 'voice', at: w.now });
    bargeIn.naviStarted();
    expect(bargeIn.canSpeak()).toBe(false);

    // The user talks over Navi.
    bargeIn.userSpeechStarted();
    w.bus.emit('voice.speech_started', { at: w.now });
    expect(fades).toEqual([FADE_OUT_MS]);
    expect(FADE_OUT_MS).toBeLessThanOrEqual(180);
    expect(mouthStopped).toBe(true);
    expect(w.orch.conversation.recentTurns(1)[0]).toMatchObject({ role: 'navi', interrupted: true });

    bargeIn.userSpeechEnded();
    await w.orch.handleUtterance({ id: 'u2', text: 'ちょっと待って', source: 'voice', at: w.now });
    expect(bargeIn.canSpeak()).toBe(true);
    expect(w.spoken).toHaveLength(2);
    // The model is told its previous line was cut off.
    const history = w.chat.calls[1]!.messages.map((m) => m.content).join('\n');
    expect(history).toContain('（途中で遮られた）');
  });

  it('an interrupt while the reply is still being generated drops that reply', async () => {
    const w = world();
    const pending = w.orch.handleUtterance({ id: 'u1', text: '長い話して', source: 'text', at: w.now });
    w.orch.interrupt();
    const res = await pending;
    expect(res.speak).toBe(false);
    expect(w.spoken).toEqual([]);
  });
});

describe('orchestrator metrics emits', () => {
  it('times chat and vision calls and reports failures', async () => {
    const vision = new FakeOllama([JSON.stringify({ summary: '財布の商品ページ', referent: '黒い財布', ocr: '¥3,980', confidence: 0.9 })]);
    const w = world({ vision });
    const timings: Array<NaviEvents['metrics.timing']> = [];
    const errors: Array<NaviEvents['metrics.error']> = [];
    w.bus.on('metrics.timing', (t) => timings.push(t));
    w.bus.on('metrics.error', (e) => errors.push(e));

    await w.orch.handleUtterance({ id: 'u1', text: 'これどう思う？', source: 'text', at: w.now });
    expect(timings.map((t) => t.kind)).toEqual(['vision', 'chat']);
    expect(timings[1]!.ms).toBe(800);

    w.chat.chat = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    };
    await w.orch.handleUtterance({ id: 'u2', text: '今日なにしよう', source: 'text', at: w.now });
    expect(errors).toEqual([{ service: 'chat', message: 'Error: connect ECONNREFUSED 127.0.0.1:11434', at: w.now }]);
    // No conversation text reaches the metrics.
    expect(JSON.stringify(w.metrics.snapshot())).not.toMatch(/今日なにしよう|これどう思う|財布/);
  });
});
