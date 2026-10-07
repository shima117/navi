function tokens(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[\s、。！？!?.,]/g, '');
  if (!normalized) return [];
  if (normalized.length < 3) return [normalized];
  return Array.from({ length: normalized.length - 1 }, (_, i) => normalized.slice(i, i + 2));
}

export function textSimilarity(a: string, b: string): number {
  const aa = new Set(tokens(a));
  const bb = new Set(tokens(b));
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const token of aa) if (bb.has(token)) hit++;
  return hit / Math.max(aa.size, bb.size);
}

export interface EchoEvidence {
  transcript: string;
  playbackText: string;
  audioCorrelation: number;
  playbackActive: boolean;
  playbackAgeMs: number;
}

export interface EchoDecision {
  echo: boolean;
  confidence: number;
  textSimilarity: number;
}

/** Text alone can never suppress speech; timing and audio reference must corroborate it. */
export function classifyEcho(evidence: EchoEvidence): EchoDecision {
  const similarity = textSimilarity(evidence.transcript, evidence.playbackText);
  const timing = evidence.playbackActive || evidence.playbackAgeMs <= 650 ? 1 : 0;
  const confidence = similarity * 0.35 + Math.max(0, Math.min(1, evidence.audioCorrelation)) * 0.5 + timing * 0.15;
  return { echo: similarity >= 0.55 && evidence.audioCorrelation >= 0.5 && timing === 1 && confidence >= 0.62, confidence, textSimilarity: similarity };
}

