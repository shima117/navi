/**
 * Lip-sync timeline from a VOICEVOX AudioQuery (design doc §2.2).
 * Produces keyframes for ParamMouthOpenY / ParamMouthForm.
 */
export interface VoicevoxMora {
  text: string;
  consonant?: string | null;
  consonant_length?: number | null;
  vowel: string;
  vowel_length: number;
  pitch: number;
}

export interface VoicevoxAccentPhrase {
  moras: VoicevoxMora[];
  pause_mora?: VoicevoxMora | null;
}

export interface VoicevoxAudioQuery {
  accent_phrases: VoicevoxAccentPhrase[];
  speedScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  [key: string]: unknown;
}

export interface LipSyncKeyframe {
  /** ms from audio start */
  t: number;
  open: number;
  /** -1 (rounded "o/u") .. 1 (wide "i/e") */
  form: number;
}

const VOWEL_SHAPES: Record<string, { open: number; form: number }> = {
  a: { open: 1.0, form: 0.2 },
  i: { open: 0.3, form: 1.0 },
  u: { open: 0.3, form: -0.7 },
  e: { open: 0.6, form: 0.6 },
  o: { open: 0.75, form: -0.5 },
  N: { open: 0.12, form: 0 },
  cl: { open: 0, form: 0 },
  pau: { open: 0, form: 0 },
};

function shapeFor(vowel: string): { open: number; form: number } {
  const direct = VOWEL_SHAPES[vowel];
  if (direct) return direct;
  // Uppercase = devoiced vowel in VOICEVOX: barely open.
  const lower = VOWEL_SHAPES[vowel.toLowerCase()];
  return lower ? { open: lower.open * 0.25, form: lower.form * 0.5 } : { open: 0, form: 0 };
}

export function buildLipSyncTimeline(query: VoicevoxAudioQuery): LipSyncKeyframe[] {
  const speed = query.speedScale > 0 ? query.speedScale : 1;
  const frames: LipSyncKeyframe[] = [{ t: 0, open: 0, form: 0 }];
  let t = (query.prePhonemeLength / speed) * 1000;
  frames.push({ t, open: 0, form: 0 });

  const pushMora = (m: VoicevoxMora) => {
    const consonant = ((m.consonant_length ?? 0) / speed) * 1000;
    const vowel = (m.vowel_length / speed) * 1000;
    if (consonant > 0) {
      // Consonants close the mouth slightly before the vowel opens it.
      t += consonant;
      frames.push({ t, open: 0.1, form: frames[frames.length - 1]!.form });
    }
    const shape = shapeFor(m.vowel);
    // Reach the vowel shape quickly, hold, then ease off toward the next mora.
    frames.push({ t: t + Math.min(40, vowel * 0.3), ...shape });
    t += vowel;
    frames.push({ t, open: shape.open * 0.6, form: shape.form });
  };

  for (const phrase of query.accent_phrases) {
    for (const mora of phrase.moras) pushMora(mora);
    if (phrase.pause_mora) pushMora(phrase.pause_mora);
  }
  frames.push({ t: t + 60, open: 0, form: 0 });
  t += (query.postPhonemeLength / speed) * 1000;
  frames.push({ t: Math.max(t, frames[frames.length - 1]!.t), open: 0, form: 0 });
  return frames;
}

/** Linear interpolation of a timeline at time t (ms). */
export function sampleLipSync(frames: LipSyncKeyframe[], t: number): { open: number; form: number } {
  if (frames.length === 0) return { open: 0, form: 0 };
  if (t <= frames[0]!.t) return { open: frames[0]!.open, form: frames[0]!.form };
  for (let i = 1; i < frames.length; i++) {
    const b = frames[i]!;
    if (t <= b.t) {
      const a = frames[i - 1]!;
      const span = b.t - a.t;
      const k = span > 0 ? (t - a.t) / span : 1;
      return { open: a.open + (b.open - a.open) * k, form: a.form + (b.form - a.form) * k };
    }
  }
  return { open: 0, form: 0 };
}
