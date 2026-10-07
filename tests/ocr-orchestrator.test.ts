import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/EventBus';
import { ModelRouter } from '../src/core/ai/ModelRouter';
import { ResourceGovernor } from '../src/core/resource/ResourceGovernor';
import { InMemoryMemoryStore } from '../src/core/memory/MemoryStore';
import { PluginHost } from '../src/core/plugins/PluginHost';
import { FriendOrchestrator } from '../src/core/orchestrator/FriendOrchestrator';
import { InitiativeScheduler } from '../src/core/initiative/InitiativeScheduler';
import { VisionService, type FrameProvider } from '../src/core/screen/VisionService';
import { toScreenOcr } from '../src/core/screen/OcrAnalysis';
import type { FrameSummary } from '../src/core/screen/FrameSummary';
import type { UserUtterance } from '../src/core/types';
import { FakeOllama, reply } from './helpers';

const T0 = 1_000_000;

function setup(opts: { chat: FakeOllama; vision?: FakeOllama; visionHealthy?: boolean; frameSource?: string }) {
  const bus = new EventBus();
  const governor = new ResourceGovernor('DESKTOP_CHAT');
  const router = new ModelRouter(governor);
  const clock = { now: T0, sharing: true };
  const frames: FrameProvider = {
    getFrame: async () => ({
      frameId: 'f1',
      capturedAt: clock.now - 100,
      sourceId: opts.frameSource ?? 's1',
      sourceName: 'Chrome',
      imageBase64: 'AAAA',
    }),
  };
  const vision = new VisionService(opts.vision ?? new FakeOllama([]), router, governor, frames);
  const spoken: string[] = [];
  bus.on('friend.speak', (s) => spoken.push(s.text));
  const orch = new FriendOrchestrator({
    bus,
    ollama: opts.chat,
    router,
    memory: new InMemoryMemoryStore(),
    plugins: new PluginHost(bus),
    vision,
    persona: { userName: 'ユーザー' },
    isHealthy: (s) => (s === 'chat' ? true : (opts.visionHealthy ?? true)),
    initiative: new InitiativeScheduler(undefined, () => 0.5),
    sharing: () => clock.sharing,
    now: () => clock.now,
  });
  /** What the renderer would send for one OCR'd frame. */
  const ocr = (text: string, at = clock.now - 500, sourceId = 's1') =>
    bus.emit('screen.ocr', toScreenOcr({ frameId: `f${at}`, sourceId, capturedAt: at, text }, 'Chrome')!);
  const frame = (over: Partial<FrameSummary> = {}) =>
    bus.emit('screen.frame', {
      frameId: 'fx',
      capturedAt: clock.now - 300,
      sourceId: 's1',
      hash: '0000000000000000',
      change: 0.02,
      width: 1280,
      height: 720,
      ...over,
    });
  return { bus, orch, clock, spoken, ocr, frame };
}

const chatContext = (chat: FakeOllama, call = 0) => chat.calls[call]!.messages[1]!.content;
const utt = (text: string, at: number): UserUtterance => ({ id: text, text, source: 'text', at });

describe('FriendOrchestrator × OCR', () => {
  it('speaks about a price tag from OCR alone, without waking Vision', async () => {
    const chat = new FakeOllama([reply('1,980円ですか。セールなら割と悪くないですね')]);
    const vision = new FakeOllama([]);
    const { orch, ocr, spoken } = setup({ chat, vision });
    ocr('週末セール 30%OFF / 税込 \\1,980');

    const d = await orch.considerInitiative();
    expect(d.speak).toBe(true);
    expect(vision.calls).toHaveLength(0);
    expect(spoken).toEqual(['1,980円ですか。セールなら割と悪くないですね']);
    const ctx = chatContext(chat);
    expect(ctx).toContain('共有画面に値段が出ている: 1,980円');
    expect(ctx).toContain('セール表示あり');
    expect(ctx).toContain('画面の文字: 週末セール 30%OFF / 税込 \\1,980');
    // Never claims to see more than the text.
    expect(ctx).toContain('画像は見ていない');
  });

  it('stays quiet about prices during focus (combat etc.)', async () => {
    const chat = new FakeOllama([]);
    const { orch, ocr, bus, clock } = setup({ chat });
    bus.emit('plugin.event', { pluginId: 'g', kind: 'combat', description: '戦闘中', importance: 0.1, at: clock.now, focus: true });
    ocr('¥1,980');
    const d = await orch.considerInitiative();
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('focus');
    expect(chat.calls).toHaveLength(0);
  });

  it('stays quiet while the user is speaking, and with the "静かめ" setting', async () => {
    const chat = new FakeOllama([]);
    const { orch, ocr, bus } = setup({ chat });
    ocr('¥1,980');
    bus.emit('voice.speech_started', { at: T0 });
    expect((await orch.considerInitiative()).reason).toBe('user_speaking');
    expect(chat.calls).toHaveLength(0);
  });

  it('does not bring up the same price tag twice, but does a new one', async () => {
    const chat = new FakeOllama([reply('1,980円は高いです'), reply('今度は980円ですか。こっちですね')]);
    const { orch, ocr, clock, spoken } = setup({ chat });
    ocr('¥1,980');
    expect((await orch.considerInitiative()).speak).toBe(true);

    // Two minutes later the same page is OCR'd again (e.g. after scrolling back).
    clock.now += 120_000;
    ocr('税込 1,980円');
    expect((await orch.considerInitiative()).speak).toBe(false);

    ocr('¥980');
    expect((await orch.considerInitiative()).speak).toBe(true);
    expect(spoken).toEqual(['1,980円は高いです', '今度は980円ですか。こっちですね']);
  });

  it('respects the recent-speech penalty like any other candidate', async () => {
    const chat = new FakeOllama([reply('どうも'), reply('呼ばれてないのに喋る')]);
    const { orch, ocr, clock } = setup({ chat });
    await orch.handleUtterance(utt('やあ', clock.now));
    clock.now += 10_000;
    ocr('¥1,980');
    expect((await orch.considerInitiative()).speak).toBe(false);
    expect(chat.calls).toHaveLength(1);
  });

  it('ignores stale OCR, other sources and screens that are no longer shared', async () => {
    const chat = new FakeOllama([]);
    const a = setup({ chat });
    a.ocr('¥1,980', a.clock.now - 30_000);
    expect((await a.orch.considerInitiative()).speak).toBe(false);

    const b = setup({ chat });
    b.ocr('¥1,980');
    b.frame({ sourceId: 's2' }); // the user switched to another window
    expect((await b.orch.considerInitiative()).speak).toBe(false);

    const c = setup({ chat });
    c.ocr('¥1,980');
    c.clock.sharing = false;
    expect((await c.orch.considerInitiative()).speak).toBe(false);
    expect(chat.calls).toHaveLength(0);
  });

  it('a bare "1.2k" (view counts…) is not a price tag', async () => {
    const chat = new FakeOllama([]);
    const { orch, ocr } = setup({ chat });
    ocr('再生回数 1.2k');
    expect((await orch.considerInitiative()).speak).toBe(false);
  });

  it('a sale sign without a price asks Vision, with the OCR text as a hint', async () => {
    const vision = new FakeOllama([
      JSON.stringify({ summary: 'スーパーの棚に半額シールの弁当', referent: null, ocr: '半額', confidence: 0.8 }),
    ]);
    const chat = new FakeOllama([reply('半額シール…弁当ですね。私なら迷わず取ります')]);
    const { orch, ocr, spoken } = setup({ chat, vision });
    ocr('半額 本日限り');
    expect((await orch.considerInitiative()).speak).toBe(true);
    expect(vision.calls).toHaveLength(1);
    expect(vision.calls[0]!.messages[1]!.content).toContain('OCRで読めた文字: 半額 本日限り');
    expect(chatContext(chat)).toContain('半額シールの弁当');
    expect(chatContext(chat)).not.toContain('画像は見ていない');
    expect(spoken).toHaveLength(1);
  });

  it('falls back to the OCR text when Vision is unavailable', async () => {
    const chat = new FakeOllama([reply('半額って書いてありますね')]);
    const { orch, ocr } = setup({ chat, visionHealthy: false });
    ocr('半額セール');
    expect((await orch.considerInitiative()).speak).toBe(true);
    expect(chatContext(chat)).toContain('画像は見ていない');
  });

  it('hands Vision the changed area and OCR text when the user says これ', async () => {
    const vision = new FakeOllama([
      JSON.stringify({ summary: '右下に値札のポップアップ', referent: '右下の値札', ocr: '¥1,980', confidence: 0.8 }),
    ]);
    const chat = new FakeOllama([reply('右下のやつですか。1,980円なら私は買いません')]);
    const { orch, ocr, frame, clock } = setup({ chat, vision });
    frame({ changedRegions: ['右下'], sceneScore: 0.35, change: 0.1 });
    ocr('¥1,980');
    await orch.handleUtterance(utt('これどう思う？', clock.now));
    const prompt = vision.calls[0]!.messages[1]!.content;
    expect(prompt).toContain('変化した領域: 右下');
    expect(prompt).toContain('OCRで読めた文字: ¥1,980');
    expect(chatContext(chat)).toContain('右下の値札');
  });

  it('never passes hints from another source to Vision', async () => {
    const vision = new FakeOllama([JSON.stringify({ summary: '別の画面', referent: null, ocr: '', confidence: 0.8 })]);
    const chat = new FakeOllama([reply('ふむ')]);
    const { orch, ocr, frame, clock } = setup({ chat, vision, frameSource: 's2' });
    frame({ changedRegions: ['左上'], sceneScore: 0.4 });
    ocr('¥1,980');
    await orch.handleUtterance(utt('これ何？', clock.now));
    const prompt = vision.calls[0]!.messages[1]!.content;
    expect(prompt).not.toContain('変化した領域');
    expect(prompt).not.toContain('OCR');
  });
});
