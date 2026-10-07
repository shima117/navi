import type { FetchLike } from '../ai/OllamaClient';
import type { VoicevoxAudioQuery } from './LipSync';
import type { TtsAdapter, TtsResult } from './TtsAdapter';
import { performanceFor, type VoicePerformance } from './VoiceStyle';

/** Voice tuning for Navi (§11.3): small, slightly high, flat unless excited. */
export interface VoiceStyle {
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
}

export const BASE_VOICE: VoiceStyle = { speedScale: 0.95, pitchScale: 0, intonationScale: 0.82, volumeScale: 0.9 };

/** Adjust delivery by emotion: excited → faster, embarrassed → quieter, unimpressed → flat. */
export function voiceStyleFor(emotion: string, intensity: number, temperature: string): VoiceStyle {
  const p = performanceFor(emotion, intensity, temperature);
  return { speedScale: p.speed, pitchScale: p.pitch, intonationScale: p.intonation, volumeScale: p.volume };
}

export class VoicevoxClient implements TtsAdapter {
  readonly id = 'voicevox';
  constructor(
    private readonly speakerId: number,
    private readonly baseUrl = 'http://127.0.0.1:50021',
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
  ) {}

  async audioQuery(text: string): Promise<VoicevoxAudioQuery> {
    const url = `${this.baseUrl}/audio_query?speaker=${this.speakerId}&text=${encodeURIComponent(text)}`;
    const res = await this.fetchImpl(url, { method: 'POST' });
    if (!res.ok) throw new Error(`VOICEVOX audio_query failed: ${res.status}`);
    return (await res.json()) as VoicevoxAudioQuery;
  }

  async synthesize(text: string, performance: VoicePerformance | VoiceStyle): Promise<TtsResult> {
    const style: VoiceStyle = 'speed' in performance
      ? {
          speedScale: performance.speed,
          pitchScale: performance.pitch,
          intonationScale: performance.intonation,
          volumeScale: performance.volume,
        }
      : performance;
    const query = { ...(await this.audioQuery(text)), ...style };
    const res = await this.fetchImpl(`${this.baseUrl}/synthesis?speaker=${this.speakerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
    });
    if (!res.ok) throw new Error(`VOICEVOX synthesis failed: ${res.status}`);
    return { audio: await res.arrayBuffer(), query, mimeType: 'audio/wav' };
  }

  async health(): Promise<boolean> {
    try {
      return (await this.fetchImpl(`${this.baseUrl}/version`)).ok;
    } catch {
      return false;
    }
  }

  /** Backwards-compatible health name used by the existing monitor. */
  ping(): Promise<boolean> {
    return this.health();
  }
}

export type { TtsAdapter } from './TtsAdapter';
