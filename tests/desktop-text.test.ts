import { describe, expect, it, vi } from 'vitest';
import { detectTextIntent, normalizeTextSettings } from '../src/core/desktopText/DesktopText';
import { EventBus } from '../src/core/events/EventBus';
import { FriendOrchestrator } from '../src/core/orchestrator/FriendOrchestrator';
import { ModelRouter } from '../src/core/ai/ModelRouter';
import { ResourceGovernor } from '../src/core/resource/ResourceGovernor';
import { InMemoryMemoryStore } from '../src/core/memory/MemoryStore';
import { PluginHost } from '../src/core/plugins/PluginHost';
import { FakeOllama, reply } from './helpers';
import type { VisionService } from '../src/core/screen/VisionService';

function setup() {
  const bus = new EventBus();
  const replies = [reply('確認しました。')];
  const chat = new FakeOllama(replies);
  const command = vi.fn();
  const speak = vi.fn();
  const observe = vi.fn(async () => null);
  bus.on('friend.speak', speak);
  const orch = new FriendOrchestrator({
    bus, ollama: chat, router: new ModelRouter(new ResourceGovernor()), memory: new InMemoryMemoryStore(),
    plugins: new PluginHost(bus), vision: { observe } as unknown as VisionService, persona: { userName: 'しま' }, isHealthy: () => true,
    desktopText: { visible: () => true, command, taskStatus: () => '今は裏で動いている作業はありません。' },
  });
  const say = (text: string) => orch.handleUtterance({ id: text, source: 'text', at: 1, text });
  return { chat, replies, command, speak, say, observe, orch, bus };
}

describe('desktop text routing', () => {
  it('defaults explicit text requests to no voice, and honors explicit read-aloud', () => {
    expect(detectTextIntent('答えをテキストで見せて')).toEqual({ kind: 'answer', query: '答えを', readAloud: false });
    expect(detectTextIntent('答えを文字で出して、読み上げて')).toEqual({ kind: 'answer', query: '答えを', readAloud: true });
  });
  it('does not hijack ordinary speech or a request to erase a file', () => {
    expect(detectTextIntent('このファイルを消して', true).kind).toBe('none');
    expect(detectTextIntent('次に何する？', true).kind).toBe('none');
    expect(detectTextIntent('消して', false).kind).toBe('none');
    expect(detectTextIntent('次', true)).toEqual({ kind: 'command', command: 'next' });
  });
  it('handles display controls without calling the model', async () => {
    const s = setup();
    await s.say('文字を大きくして');
    expect(s.command).toHaveBeenCalledWith('bigger');
    expect(s.chat.calls).toHaveLength(0);
    expect(s.speak).not.toHaveBeenCalled();
  });
  it('keeps text output scoped to one turn', async () => {
    const s = setup();
    await s.say('答えを文字で出して');
    expect(s.speak.mock.calls[0]![0].presentation).toBe('text');
    s.replies.push(reply('うん。'));
    await s.say('こんばんは');
    expect(s.speak.mock.calls[1]![0].presentation).toBe('voice');
  });
  it('reads task snapshots locally even without a worker', async () => {
    const s = setup();
    await s.say('進捗をテキストで出して');
    expect(s.chat.calls).toHaveLength(0);
    expect(s.speak.mock.calls[0]![0]).toMatchObject({ presentation: 'text', textMode: 'TASK_STATUS', text: '今は裏で動いている作業はありません。' });
  });
  it('allows longer written answers while keeping spoken replies short', async () => {
    const s = setup();
    const long = '詳しく説明します。'.repeat(10);
    s.replies.splice(0, 1, reply(long));
    await s.say('答えを文字で出して');
    expect(s.speak.mock.calls[0]![0].text).toBe(long);
    expect(s.chat.calls).toHaveLength(1);
  });
  it('normalizes invalid/unbounded appearance settings', () => {
    const s = normalizeTextSettings({ fontSize: 1000, maxWidth: -1, opacity: NaN, color: 'url(https://bad)' });
    expect(s.fontSize).toBe(72);
    expect(s.maxWidth).toBe(240);
    expect(s.opacity).toBe(.98);
    expect(s.color).toBe('#ffffff');
  });
  it('does not inspect the screen just because the output should appear there', async () => {
    const s = setup();
    await s.say('答えを画面に出して');
    expect(s.observe).not.toHaveBeenCalled();
    expect(s.speak.mock.calls[0]![0].presentation).toBe('text');
  });
  it('defers worker completion during user speech and reports verified success without a model call', () => {
    const s = setup();
    const snapshot: import('../src/core/tasks/TaskSnapshotPublisher').TaskSnapshot = {
      id: 'a', title: '環境確認', status: 'DONE', currentAction: '確認済み', phase: 'complete',
      progress: 1, eta: null, lastUpdateAt: 2,
      lastReport: { taskId: 'a', action: 'check', state: 'SUCCESS', summary: '確認済み',
        verified: true, verification: { method: 'HTTP', result: 'PASS', evidence: 'HTTP 200' }, timestamp: 2 },
    };
    s.bus.emit('voice.speech_started', { at: 1, source: 'USER_MIC' });
    expect(s.orch.reportTask(snapshot)).toBe(false);
    expect(s.speak).not.toHaveBeenCalled();
    s.bus.emit('voice.speech_ended', { at: 2, source: 'USER_MIC' });
    expect(s.orch.reportTask(snapshot)).toBe(true);
    expect(s.speak.mock.calls[0]![0].text).toContain('確認も通っています');
    expect(s.chat.calls).toHaveLength(0);
  });
});
