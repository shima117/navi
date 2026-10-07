import type { Emotion, Temperature } from '../types';

export interface VoicePerformance {
  emotion: Emotion;
  intensity: number;
  speed: number;
  pitch: number;
  intonation: number;
  volume: number;
  preDelayMs: number;
  postDelayMs: number;
}

/** Quiet, slightly high and restrained; aligned with the supplied Navi character sheet. */
export const NAVI_BASE: Omit<VoicePerformance, 'emotion' | 'intensity'> = {
  speed: 0.95,
  pitch: 0,
  intonation: 0.82,
  volume: 0.9,
  preDelayMs: 180,
  postDelayMs: 80,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function performanceFor(emotion: Emotion | string, intensity: number, temperature: Temperature | string = 'normal'): VoicePerformance {
  const i = clamp(intensity, 0, 1);
  const p: VoicePerformance = { emotion: emotion as Emotion, intensity: i, ...NAVI_BASE };
  if (temperature === 'dense' || emotion === 'interested') {
    p.speed += 0.08 * i;
    p.intonation += 0.09 * i;
  }
  if (emotion === 'happy' || emotion === 'surprised') {
    p.speed += 0.09 * i;
    p.pitch += 0.025 * i;
    p.intonation += 0.14 * i;
  }
  if (emotion === 'embarrassed') {
    p.speed -= 0.08 * i;
    p.pitch += 0.02 * i;
    p.volume -= 0.22 * i;
    p.preDelayMs += 120 * i;
  }
  if (emotion === 'unimpressed' || emotion === 'annoyed') {
    p.intonation -= 0.34 * i;
    p.speed -= 0.03 * i;
  }
  if (emotion === 'tired' || emotion === 'worried') {
    p.speed -= 0.1 * i;
    p.volume -= 0.12 * i;
    p.intonation -= 0.15 * i;
  }
  if (emotion === 'focused') {
    p.speed += 0.03 * i;
    p.intonation -= 0.08 * i;
    p.preDelayMs -= 60 * i;
  }
  if (emotion === 'confused') p.preDelayMs += 90 * i;
  if (emotion === 'relieved') {
    p.speed -= 0.04 * i;
    p.volume -= 0.04 * i;
  }
  if (temperature === 'thin') p.intonation = Math.min(p.intonation, 0.7);
  p.speed = clamp(p.speed, 0.75, 1.2);
  p.pitch = clamp(p.pitch, -0.1, 0.1);
  p.intonation = clamp(p.intonation, 0.4, 1.25);
  p.volume = clamp(p.volume, 0.55, 1);
  p.preDelayMs = Math.round(clamp(p.preDelayMs, 60, 400));
  p.postDelayMs = Math.round(clamp(p.postDelayMs, 0, 300));
  return p;
}

