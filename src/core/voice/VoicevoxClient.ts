import type { FetchLike } from '../ai/OllamaClient';
import type { VoicevoxAudioQuery } from './LipSync';

/** Voice tuning for Navi (§11.3): small, slightly high, flat unless excited. */
export interface VoiceStyle {
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
}

export const BASE_VOICE: VoiceStyle = { speedScale: 1.0, pitchScale: 0.03, intonationScale: 0.85, volumeScale: 0.8 };

/** Adjust delivery by emotion: excited → faster, embarrassed → quieter, unimpressed → flat. */
export function voiceStyleFor(emotion: string, intensity: number, temperature: string): VoiceStyle {
  const s = { ...BASE_VOICE };
  if (temperature === 'dense' || emotion === 'happy' || emotion === 'surprised') {
    s.speedScale += 0.12 * intensity + 0.05;
    s.intonationScale += 0.2 * intensity;
  }
  if (emotion === 'embarrassed') {
    s.volumeScale -= 0.25 * intensity;
    s.speedScale -= 0.05;
  }
  if (emotion === 'unimpressed' || emotion === 'tired') {
    s.intonationScale = Math.max(0.4, s.intonationScale - 0.4 * intensity);
  }
  if (temperature === 'thin') s.intonationScale = Math.min(s.intonationScale, 0.7);
  return s;
}

/** Abstract TTS so another local engine can be swapped in later (§3.4). */
export interface TtsAdapter {
  synthesize(text: string, style: VoiceStyle): Promise<{ audio: ArrayBuffer; query: VoicevoxAudioQuery | null }>;
  ping(): Promise<boolean>;
}

export class VoicevoxClient implements TtsAdapter {
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

  async synthesize(text: string, style: VoiceStyle): Promise<{ audio: ArrayBuffer; query: VoicevoxAudioQuery }> {
    const query = { ...(await this.audioQuery(text)), ...style };
    const res = await this.fetchImpl(`${this.baseUrl}/synthesis?speaker=${this.speakerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
    });
    if (!res.ok) throw new Error(`VOICEVOX synthesis failed: ${res.status}`);
    return { audio: await res.arrayBuffer(), query };
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.fetchImpl(`${this.baseUrl}/version`)).ok;
    } catch {
      return false;
    }
  }
}
