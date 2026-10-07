import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/EventBus';
import { InMemoryMemoryStore } from '../src/core/memory/MemoryStore';
import { MemoryWriter, type MemoryPolicy } from '../src/core/memory/MemoryWriter';
import type { CompanionResponse, Turn } from '../src/core/types';
import { count, makeStore, T0 } from './memory-helpers';

const response = (topic_action: CompanionResponse['topic_action'], speak = true): CompanionResponse => ({
  speak,
  text: speak ? 'そうですか' : '',
  temperature: 'normal',
  emotion: 'neutral',
  intensity: 0.4,
  gaze: 'user',
  gesture: 'small_nod',
  memory_write: [],
  topic_action,
  needs_vision: false,
  needs_tool: null,
});

const cue = { emotion: 'neutral', intensity: 0.4, gaze: 'user', gesture: 'still' } as const;

function setup(initial: Partial<MemoryPolicy> = {}) {
  const bus = new EventBus();
  const { store, db } = makeStore();
  const policy: MemoryPolicy = { persistMemory: false, persistUtterances: false, ...initial };
  const turns: Turn[] = [];
  const writer = new MemoryWriter({
    bus,
    store,
    journal: store,
    policy: () => policy,
    turns: { record: (t) => turns.push(t) },
    now: () => T0,
  });
  writer.attach();
  bus.emit('session.started', { at: T0 });
  return { bus, store, db, policy, turns, writer };
}

function chat(bus: EventBus, userText: string, action: CompanionResponse['topic_action'] = 'continue') {
  bus.emit('voice.transcript', { id: userText, text: userText, source: 'voice', at: T0 });
  bus.emit('friend.response', response(action));
  bus.emit('friend.speak', { text: 'そうですか', cue });
}

describe('MemoryWriter', () => {
  it('stores memory.write events once, even when the orchestrator already wrote them', () => {
    const { bus, store } = setup();
    store.write('ユーザーはタルコフが好き', 'session', T0);
    bus.emit('memory.write', { text: 'ユーザーはタルコフが好き', tier: 'session' });
    bus.emit('memory.write', { text: 'ユーザーは辛いものが苦手', tier: 'session' });
    bus.emit('memory.write', { text: '   ', tier: 'session' });
    expect(store.list().map((m) => m.text).sort()).toEqual(['ユーザーは辛いものが苦手', 'ユーザーはタルコフが好き'].sort());
  });

  it('does not persist utterances, screen or topics by default', () => {
    const { bus, db, turns } = setup();
    chat(bus, 'タルコフのタスクが終わらない');
    bus.emit('screen.observed', {
      frameId: 'f',
      capturedAt: T0,
      sourceId: 's',
      sourceName: 'Chrome',
      summary: 'ログイン画面',
      confidence: 0.9,
    });
    bus.emit('plugin.event', { pluginId: 'tarkov', kind: 'death', description: '死亡した', importance: 0.9, at: T0 });
    for (const t of ['utterances', 'screen_events', 'topics']) expect(count(db, t)).toBe(0);
    // The summarizer's RAM buffer still sees the conversation.
    expect(turns.map((t) => t.role)).toEqual(['user', 'navi']);
  });

  it('logs utterances, screen summaries and topics when opted in', () => {
    const { bus, db, store } = setup({ persistUtterances: true });
    chat(bus, 'タルコフのタスクが終わらない', 'shift');
    chat(bus, '工場で詰まってる', 'continue');
    bus.emit('screen.observed', {
      frameId: 'f',
      capturedAt: T0,
      sourceId: 's',
      sourceName: 'Chrome',
      summary: '設定画面',
      ocrText: 'password hunter2',
      referent: '保存ボタン',
      confidence: 0.9,
    });
    expect(db.prepare('SELECT role, source, text FROM utterances ORDER BY id').all().map((r) => ({ ...r }))).toEqual([
      { role: 'user', source: 'voice', text: 'タルコフのタスクが終わらない' },
      { role: 'navi', source: null, text: 'そうですか' },
      { role: 'user', source: 'voice', text: '工場で詰まってる' },
      { role: 'navi', source: null, text: 'そうですか' },
    ]);
    const screen = db.prepare('SELECT * FROM screen_events').all();
    expect(screen).toHaveLength(1);
    expect(String(screen[0]!.summary)).toBe('設定画面 / 指していたもの: 保存ボタン');
    expect(JSON.stringify(screen)).not.toContain('hunter2');
    expect(store.listTopics()[0]).toMatchObject({ label: 'タルコフのタスクが終わらない', mentions: 2, starts: 1 });
  });

  it('logs notable plugin events once per minute', () => {
    const { bus, db } = setup({ persistUtterances: true });
    const ev = { pluginId: 'tarkov', kind: 'death', description: '死亡した', importance: 0.9 };
    bus.emit('plugin.event', { ...ev, at: T0 });
    bus.emit('plugin.event', { ...ev, at: T0 + 10_000 });
    bus.emit('plugin.event', { ...ev, at: T0 + 61_000 });
    bus.emit('plugin.event', { ...ev, description: '弾を拾った', importance: 0.1, at: T0 });
    expect(count(db, 'screen_events')).toBe(2);
  });

  it('follows the setting live', () => {
    const { bus, db, policy } = setup();
    chat(bus, '一回目');
    policy.persistUtterances = true;
    chat(bus, '二回目');
    policy.persistUtterances = false;
    chat(bus, '三回目');
    expect(db.prepare("SELECT text FROM utterances WHERE role = 'user'").all().map((r) => r.text)).toEqual(['二回目']);
  });

  it('ignores silent responses for topics', () => {
    const { bus, store } = setup({ persistUtterances: true });
    bus.emit('voice.transcript', { id: 'u', text: '眠い', source: 'text', at: T0 });
    bus.emit('friend.response', response('shift', false));
    expect(store.listTopics()).toEqual([]);
  });

  it('records session start and end', () => {
    const { bus, db } = setup();
    bus.emit('session.ended', { at: T0 + 5000 });
    expect(db.prepare('SELECT started_at, ended_at FROM sessions').all().map((r) => ({ ...r }))).toEqual([
      { started_at: T0, ended_at: T0 + 5000 },
    ]);
  });

  it('stops listening after detach', () => {
    const { bus, store, writer } = setup();
    writer.detach();
    bus.emit('memory.write', { text: 'ユーザーはタルコフが好き', tier: 'session' });
    expect(store.list()).toEqual([]);
  });

  it('works without a journal (in-memory fallback)', () => {
    const bus = new EventBus();
    const store = new InMemoryMemoryStore();
    new MemoryWriter({ bus, store, journal: null, policy: () => ({ persistMemory: true, persistUtterances: true }) }).attach();
    bus.emit('session.started', { at: T0 });
    expect(() => chat(bus, 'こんにちは')).not.toThrow();
    bus.emit('memory.write', { text: 'ユーザーはタルコフが好き', tier: 'session' });
    expect(store.list()).toHaveLength(1);
  });
});
