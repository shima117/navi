import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/EventBus';
import { ModelRouter } from '../src/core/ai/ModelRouter';
import { ResourceGovernor } from '../src/core/resource/ResourceGovernor';
import { InMemoryMemoryStore } from '../src/core/memory/MemoryStore';
import { PluginHost } from '../src/core/plugins/PluginHost';
import { FriendOrchestrator } from '../src/core/orchestrator/FriendOrchestrator';
import { VisionService, type FrameProvider } from '../src/core/screen/VisionService';
import { FakeOllama, reply } from './helpers';
import type { UserUtterance } from '../src/core/types';

const utt = (text: string): UserUtterance => ({ id: text, text, source: 'text', at: 1_000 });

function setup(opts: {
  chat: FakeOllama;
  vision?: FakeOllama;
  frame?: boolean;
  chatHealthy?: boolean;
  visionHealthy?: boolean;
  recentSystemAudio?: () => Promise<{ type: string; confidence: number; at: number } | null>;
}) {
  const bus = new EventBus();
  const governor = new ResourceGovernor('DESKTOP_CHAT');
  const router = new ModelRouter(governor);
  const frames: FrameProvider = {
    getFrame: async () =>
      opts.frame === false
        ? null
        : { frameId: 'f1', capturedAt: 900, sourceId: 's1', sourceName: 'Chrome', imageBase64: 'AAAA' },
  };
  const vision = opts.vision ? new VisionService(opts.vision, router, governor, frames) : null;
  const plugins = new PluginHost(bus);
  const spoken: string[] = [];
  const silent: string[] = [];
  bus.on('friend.speak', (s) => spoken.push(s.text));
  bus.on('friend.silent', (s) => silent.push(s.reason));
  const orch = new FriendOrchestrator({
    bus,
    ollama: opts.chat,
    router,
    memory: new InMemoryMemoryStore(),
    plugins,
    vision,
    persona: { userName: 'ユーザー' },
    isHealthy: (s) => (s === 'chat' ? (opts.chatHealthy ?? true) : (opts.visionHealthy ?? true)),
    sharing: () => true,
    now: () => 1_000,
    recentSystemAudio: opts.recentSystemAudio,
  });
  return { bus, orch, spoken, silent, plugins };
}

describe('FriendOrchestrator', () => {
  it('announces API receipt without treating generated text as verified facts', () => {
    const { orch, spoken } = setup({ chat: new FakeOllama([]) });
    expect(orch.reportTask({ id: 'cloud-task', title: 'OpenAIへの文章相談', status: 'DONE', phase: 'complete',
      currentAction: '回答受信', progress: 1, eta: null, lastUpdateAt: 1000,
      lastReport: { taskId: 'cloud-task', action: 'OPENAI_TEXT', state: 'SUCCESS', summary: '試験用回答', verified: true, timestamp: 1000,
        verification: { method: 'HTTP', result: 'PASS', evidence: 'response received, not factual verification' } } })).toBe(true);
    expect(spoken[0]).toContain('内容の正しさまでは確認できていません');
    expect(spoken[0]).not.toContain('確認も通っています');
  });
  it('plain chat does not call vision', async () => {
    const chat = new FakeOllama([reply('お疲れさまです。まあ私も今日は何もしたくないですけど')]);
    const vision = new FakeOllama([]);
    const { orch, spoken } = setup({ chat, vision });
    await orch.handleUtterance(utt('今日仕事だるかった'));
    expect(vision.calls).toHaveLength(0);
    expect(spoken).toEqual(['お疲れさまです。まあ私も今日は何もしたくないですけど']);
  });

  it('"これどう思う？" looks at the screen and passes it to the chat model', async () => {
    const vision = new FakeOllama([
      JSON.stringify({ summary: '商品ページで2つの財布を比較している', referent: '右の黒い財布', ocr: '¥3,980 / ¥12,800', confidence: 0.8 }),
    ]);
    const chat = new FakeOllama([reply('右のやつですか。私はそっちですね。左は高いわりに微妙です')]);
    const { orch, spoken } = setup({ chat, vision });
    await orch.handleUtterance(utt('これどう思う？'));
    expect(vision.calls).toHaveLength(1);
    expect(vision.calls[0]!.messages[1]!.images).toEqual(['AAAA']);
    const ctx = chat.calls[0]!.messages[1]!.content;
    expect(ctx).toContain('右の黒い財布');
    expect(spoken[0]).toContain('右のやつ');
  });

  it('never pretends to see the screen when vision is down', async () => {
    const chat = new FakeOllama([reply('今ちょっと画面見えてないです')]);
    const { orch } = setup({ chat, vision: new FakeOllama([]), visionHealthy: false });
    await orch.handleUtterance(utt('これどう思う？'));
    expect(chat.calls[0]!.messages[1]!.content).toContain('画面は今見えていない');
  });

  it('stays silent and does not throw when the chat model is offline', async () => {
    const chat = new FakeOllama([]);
    const { orch, spoken, silent } = setup({ chat, chatHealthy: false });
    const res = await orch.handleUtterance(utt('おーい'));
    expect(res.speak).toBe(false);
    expect(spoken).toEqual([]);
    expect(silent).toEqual(['ai_offline']);
  });

  it('survives a chat error', async () => {
    const chat = new FakeOllama([new Error('connection refused')]);
    const { orch, silent } = setup({ chat });
    const res = await orch.handleUtterance(utt('おーい'));
    expect(res.speak).toBe(false);
    expect(silent).toEqual(['ai_error']);
  });

  it('strips customer-service phrases and enforces length', async () => {
    const chat = new FakeOllama([reply('いいですね。一。二。三。他に何かお手伝いできることはありますか？')]);
    const { orch, spoken } = setup({ chat });
    await orch.handleUtterance(utt('ゲーム買った'));
    expect(spoken[0]).toBe('いいですね。一。二。');
  });

  it('regenerates when the reply is too long', async () => {
    const chat = new FakeOllama([reply('あ'.repeat(200) + '。'), reply('短くしました。')]);
    const { orch, spoken } = setup({ chat });
    await orch.handleUtterance(utt('長い話して'));
    expect(chat.calls).toHaveLength(2);
    expect(spoken).toEqual(['短くしました。']);
  });

  it('a newer utterance supersedes an in-flight one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const answer = (req: { messages: Array<{ content: string }> }) =>
      reply(req.messages[req.messages.length - 1]!.content === '一つ目' ? '古い返事' : '新しい返事');
    const chat = new FakeOllama([answer, answer]);
    const origChat = chat.chat.bind(chat);
    let first = true;
    chat.chat = async (req) => {
      if (first) {
        first = false;
        await gate;
      }
      return origChat(req);
    };
    const { orch, spoken } = setup({ chat });
    const p1 = orch.handleUtterance(utt('一つ目'));
    const p2 = orch.handleUtterance(utt('二つ目'));
    await p2;
    release();
    await p1;
    expect(spoken).toEqual(['新しい返事']);
  });

  it('resolves plugin tools and asks again with the result', async () => {
    const chat = new FakeOllama([
      reply('', { speak: false, needs_tool: { name: 'lookup', args: { q: 'x' } } }),
      reply('それ後で使います。売らない方がいいです'),
    ]);
    const { orch, plugins, spoken } = setup({ chat });
    plugins.register({
      id: 'g',
      displayName: 'G',
      matchWindow: () => 1,
      onSessionStart: async () => {},
      onFrame: async () => [],
      enrichVision: async () => ({ pluginId: 'g', facts: [] }),
      resolveTool: async () => ({ neededFor: ['タスクA'] }),
      getPromptContext: async () => 'G をプレイ中',
      onSessionEnd: async () => {},
    });
    await plugins.activate('g', 0);
    await orch.handleUtterance(utt('売っていい？'));
    expect(chat.calls[1]!.messages[1]!.content).toContain('タスクA');
    expect(spoken).toEqual(['それ後で使います。売らない方がいいです']);
  });

  it('marks the Navi turn as interrupted on barge-in', async () => {
    const chat = new FakeOllama([reply('長い話をしますね。')]);
    const { orch, bus } = setup({ chat });
    await orch.handleUtterance(utt('話して'));
    bus.emit('voice.interrupted', { at: 2_000 });
    const last = orch.conversation.recentTurns(1)[0]!;
    expect(last.role).toBe('navi');
    expect(last.interrupted).toBe(true);
  });

  it('uses a recent SYSTEM transient only when asked about a sound, without naming its cause', async () => {
    const chat = new FakeOllama([reply('大きな音はありましたが、種類までは分かりません。')]);
    const { orch } = setup({
      chat,
      recentSystemAudio: async () => ({ type: 'transient_candidate', confidence: 0.48, at: 950 }),
    });
    await orch.handleUtterance(utt('今の音何？'));
    const context = chat.calls[0]!.messages[1]!.content;
    expect(context).toContain('突発音の候補');
    expect(context).toContain('音の正体は未判定');
    expect(context).not.toContain('銃声');
  });
});
