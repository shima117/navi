import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { VoicevoxAudioQuery } from '../src/core/voice/LipSync';
import type { TtsAdapter, TtsResult } from '../src/core/voice/TtsAdapter';
import type { VoicePerformance } from '../src/core/voice/VoiceStyle';

/** Small pre-rendered utterances; only generated audio is persisted, never captured speech. */
export class BackchannelCache {
  private memory = new Map<string, TtsResult>();

  private key(adapter: TtsAdapter, text: string, performance: VoicePerformance): string {
    return createHash('sha256').update(JSON.stringify([adapter.id, text, performance])).digest('hex').slice(0, 20);
  }

  private dir(adapter: TtsAdapter): string {
    return path.join(app.getPath('userData'), 'cache', 'audio', 'backchannel', adapter.id);
  }

  async get(adapter: TtsAdapter, text: string, performance: VoicePerformance): Promise<TtsResult> {
    const key = this.key(adapter, text, performance);
    const cached = this.memory.get(key);
    if (cached) return { ...cached, audio: cached.audio.slice(0) };
    const dir = this.dir(adapter);
    const wav = path.join(dir, `${key}.wav`);
    const meta = path.join(dir, `${key}.json`);
    try {
      const [audio, raw] = await Promise.all([fs.readFile(wav), fs.readFile(meta, 'utf8')]);
      const result = { audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength), query: JSON.parse(raw) as VoicevoxAudioQuery };
      this.memory.set(key, result);
      return { ...result, audio: result.audio.slice(0) };
    } catch {
      const result = await adapter.synthesize(text, performance);
      await fs.mkdir(dir, { recursive: true });
      await Promise.all([
        fs.writeFile(wav, Buffer.from(result.audio)),
        fs.writeFile(meta, JSON.stringify(result.query ?? null), 'utf8'),
      ]).catch((err) => console.warn('[voice] backchannel cache write failed', err));
      this.memory.set(key, result);
      return { ...result, audio: result.audio.slice(0) };
    }
  }
}

