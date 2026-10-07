import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeechPlayer } from '../src/renderer/SpeechPlayer';

type FakeSource = { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };

const playback = vi.fn();
const lipsync = vi.fn();
const sources: FakeSource[] = [];
const decoders: Array<(value: AudioBuffer) => void> = [];

class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  setSinkId = vi.fn(async (_id: string) => undefined);
  resume = vi.fn(async () => undefined);
  decodeAudioData = vi.fn(() => new Promise<AudioBuffer>((resolve) => decoders.push(resolve)));
  createBufferSource() {
    const source = { start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null, connect: (gain: unknown) => gain };
    sources.push(source);
    return source;
  }
  createGain() {
    return {
      gain: { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: () => this.destination,
    };
  }
}

beforeEach(() => {
  sources.length = 0;
  decoders.length = 0;
  playback.mockReset();
  lipsync.mockReset();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('window', { navi: { voice: { playback }, avatar: { forwardLipSync: lipsync } } });
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => [] } });
});

afterEach(() => vi.unstubAllGlobals());

describe('SpeechPlayer sequencing', () => {
  it('serializes chunks while the first audio is decoding', async () => {
    const player = new SpeechPlayer();
    const first = player.enqueue(new ArrayBuffer(2), []);
    await player.enqueue(new ArrayBuffer(2), []);
    expect(decoders).toHaveLength(1);
    decoders[0]!({} as AudioBuffer);
    await first;
    expect(sources).toHaveLength(1);
    expect(sources[0]!.start).toHaveBeenCalledOnce();
    sources[0]!.onended?.();
    expect(decoders).toHaveLength(2);
    decoders[1]!({} as AudioBuffer);
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(sources[1]!.start).toHaveBeenCalledOnce();
  });

  it('never starts a decoded chunk after stop', async () => {
    const player = new SpeechPlayer();
    const pending = player.enqueue(new ArrayBuffer(2), []);
    player.stop();
    decoders[0]!({} as AudioBuffer);
    await pending;
    expect(sources).toHaveLength(0);
    expect(playback).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'started' }));
  });

  it('does not claim VAIO3 connection if selecting its sink fails', async () => {
    class FailingAudioContext extends FakeAudioContext {
      setSinkId = vi.fn(async (id: string) => {
        if (id === 'vaio3') throw new Error('device unavailable');
      });
    }
    vi.stubGlobal('AudioContext', FailingAudioContext);
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => [
      { kind: 'audiooutput', deviceId: 'vaio3', label: 'Voicemeeter VAIO3 Input' },
      { kind: 'audiooutput', deviceId: 'default', label: 'Default output' },
    ] } });
    const player = new SpeechPlayer();
    expect((await player.configureOutput()).status).toBe('fallback');
  });
});
