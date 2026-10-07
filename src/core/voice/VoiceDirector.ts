import type { Emotion, Temperature } from '../types';
import { performanceFor, type VoicePerformance } from './VoiceStyle';

/** Keeps voice and avatar on the exact same emotion/intensity pair. */
export class VoiceDirector {
  performance(emotion: Emotion | string, intensity: number, temperature: Temperature | string): VoicePerformance {
    return performanceFor(emotion, intensity, temperature);
  }
}

