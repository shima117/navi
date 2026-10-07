import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/events/EventBus';
import type { AppContext } from '../electron/context';
import { DEFAULT_SETTINGS } from '../electron/ipc';
import { voiceFeature } from '../electron/features/voice';
import type { TtsResult } from '../src/core/voice/TtsAdapter';
import type { PerformanceCue } from '../src/core/types';

vi.mock('electron', () => ({ app: { getPath: () => 'unused' }, ipcMain: { handle: vi.fn(), on: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

function setup(synthesize = vi.fn(async (): Promise<TtsResult> => ({ audio: new ArrayBuffer(4), query: null }))) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
  const bus = new EventBus();
  const windows = { push: vi.fn(), sendAvatar: vi.fn(), rememberAnswer: vi.fn(), showText: vi.fn() };
  const ctx = { bus, windows, voice: { tts: { id: 'test', synthesize } },
    settings: { current: DEFAULT_SETTINGS, onChange: vi.fn() },
    health: { isHealthy: () => true },
    orchestrator: { conversation: { suggestTemperature: () => 'normal' } },
  } as unknown as AppContext;
  voiceFeature.setup(ctx);
  const cue: PerformanceCue = { emotion: 'neutral', intensity: .4, gaze: 'user', gesture: 'small_nod' };
  return { bus, windows, synthesize, cue };
}

describe('text-only TTS boundary', () => {
  it('shows written output and never calls the healthy TTS engine', () => {
    const s = setup();
    s.bus.emit('friend.speak', { text: '文字だけです。', cue: s.cue, presentation: 'text' });
    expect(s.windows.showText).toHaveBeenCalledWith('文字だけです。', 'ANSWER');
    expect(s.windows.rememberAnswer).toHaveBeenCalledWith('文字だけです。');
    expect(s.synthesize).not.toHaveBeenCalled();
    expect(s.windows.push).toHaveBeenCalledWith({ type: 'stopSpeech' });
  });
  it('speaks only when both voice and text were explicitly requested', async () => {
    const s = setup();
    s.bus.emit('friend.speak', { text: '両方です。', cue: s.cue, presentation: 'both' });
    await vi.waitFor(() => expect(s.windows.push.mock.calls.some(([p]) => p.type === 'speech')).toBe(true));
    expect(s.synthesize).toHaveBeenCalledTimes(1);
    expect(s.windows.showText).toHaveBeenCalledTimes(1);
  });
  it('invalidates an already-running synthesis when switching to text only', async () => {
    let release!: (result: TtsResult) => void;
    const synthesize = vi.fn(() => new Promise<TtsResult>((resolve) => { release = resolve; }));
    const s = setup(synthesize);
    s.bus.emit('friend.speak', { text: '古い声です。', cue: s.cue, presentation: 'voice' });
    s.bus.emit('friend.speak', { text: '新しい文字です。', cue: s.cue, presentation: 'text' });
    release({ audio: new ArrayBuffer(4), query: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(s.windows.push.mock.calls.some(([p]) => p.type === 'speech')).toBe(false);
    expect(s.synthesize).toHaveBeenCalledTimes(1);
  });
});
