/** Stable source labels carried through the whole audio/conversation pipeline. */
export const AUDIO_SOURCES = ['USER_MIC', 'SYSTEM', 'REMOTE', 'NAVI_RAW', 'NAVI_FINAL'] as const;
export type AudioSource = (typeof AUDIO_SOURCES)[number];

export function isAudioSource(value: unknown): value is AudioSource {
  return typeof value === 'string' && (AUDIO_SOURCES as readonly string[]).includes(value);
}

