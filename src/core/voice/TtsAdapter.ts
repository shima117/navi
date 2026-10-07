import type { VoicevoxAudioQuery } from './LipSync';
import type { VoicePerformance } from './VoiceStyle';

export interface TtsResult {
  audio: ArrayBuffer;
  query: VoicevoxAudioQuery | null;
  mimeType?: string;
}

export interface TtsAdapter {
  readonly id: string;
  health(): Promise<boolean>;
  synthesize(text: string, performance: VoicePerformance): Promise<TtsResult>;
}

