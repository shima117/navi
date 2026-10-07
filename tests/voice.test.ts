import { describe, expect, it, vi } from 'vitest';
import { BargeInController } from '../src/core/voice/BargeIn';
import { buildLipSyncTimeline, sampleLipSync, type VoicevoxAudioQuery } from '../src/core/voice/LipSync';
import { VoicevoxClient, voiceStyleFor } from '../src/core/voice/VoicevoxClient';

const query: VoicevoxAudioQuery = {
  accent_phrases: [
    {
      moras: [
        { text: 'カ', consonant: 'k', consonant_length: 0.05, vowel: 'a', vowel_length: 0.1, pitch: 5 },
        { text: 'イ', consonant: null, consonant_length: null, vowel: 'i', vowel_length: 0.1, pitch: 5 },
      ],
      pause_mora: { text: '、', vowel: 'pau', vowel_length: 0.2, pitch: 0 },
    },
  ],
  speedScale: 1,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1,
};

describe('LipSync', () => {
  it('opens wide for あ and stays closed before/after speech', () => {
    const tl = buildLipSyncTimeline(query);
    expect(sampleLipSync(tl, 50).open).toBe(0);
    // "カ": consonant ends at 150 ms, vowel peak ~30 ms later.
    expect(sampleLipSync(tl, 180).open).toBeGreaterThan(0.8);
    // "イ" is narrow and wide-formed.
    const i = sampleLipSync(tl, 280);
    expect(i.open).toBeLessThan(0.5);
    expect(i.form).toBeGreaterThan(0.5);
    expect(sampleLipSync(tl, tl[tl.length - 1]!.t + 10).open).toBe(0);
  });

  it('scales with speedScale', () => {
    const slow = buildLipSyncTimeline(query);
    const fast = buildLipSyncTimeline({ ...query, speedScale: 2 });
    expect(fast[fast.length - 1]!.t).toBeLessThan(slow[slow.length - 1]!.t);
  });
});

describe('BargeInController', () => {
  it('fades out and marks interruption when the user talks over Navi', () => {
    const actions = { fadeOut: vi.fn(), stopMouth: vi.fn(), markInterrupted: vi.fn() };
    const c = new BargeInController(actions);
    c.naviStarted();
    expect(c.state).toBe('navi_speaking');
    c.userSpeechStarted();
    expect(actions.fadeOut).toHaveBeenCalledWith(150);
    expect(actions.stopMouth).toHaveBeenCalled();
    expect(actions.markInterrupted).toHaveBeenCalled();
    expect(c.state).toBe('user_speaking');
    expect(c.canSpeak()).toBe(false);
    c.userSpeechEnded();
    expect(c.canSpeak()).toBe(true);
  });

  it('does nothing special when the user speaks while Navi is idle', () => {
    const actions = { fadeOut: vi.fn(), stopMouth: vi.fn(), markInterrupted: vi.fn() };
    const c = new BargeInController(actions);
    c.userSpeechStarted();
    expect(actions.fadeOut).not.toHaveBeenCalled();
  });
});

describe('VOICEVOX', () => {
  it('flattens intonation when unimpressed and speeds up when excited', () => {
    expect(voiceStyleFor('unimpressed', 1, 'normal').intonationScale).toBeLessThan(0.6);
    expect(voiceStyleFor('happy', 1, 'dense').speedScale).toBeGreaterThan(1.1);
    expect(voiceStyleFor('embarrassed', 1, 'normal').volumeScale).toBeLessThan(0.7);
  });

  it('calls audio_query then synthesis with the style applied', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes('audio_query')) return new Response(JSON.stringify(query));
      return new Response(new Uint8Array([1, 2, 3]));
    };
    const client = new VoicevoxClient(8, 'http://vv', fetchImpl);
    const { audio } = await client.synthesize('かい', { speedScale: 1.2, pitchScale: 0, intonationScale: 1, volumeScale: 1 });
    expect(audio.byteLength).toBe(3);
    expect(calls[0]!.url).toBe('http://vv/audio_query?speaker=8&text=%E3%81%8B%E3%81%84');
    expect(JSON.parse(calls[1]!.body!).speedScale).toBe(1.2);
  });
});
