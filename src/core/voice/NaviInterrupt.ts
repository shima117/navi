export type NaviInterrupt = 'NONE' | 'BACKCHANNEL' | 'SOFT_INTERRUPT' | 'HARD_INTERRUPT';
export type NaviInterruptionLevel = 'LOW' | 'NORMAL' | 'HIGH';

export interface NaviInterruptEvidence {
  text: string;
  durationMs: number;
  level: NaviInterruptionLevel;
}

export interface NaviInterruptDecision {
  type: NaviInterrupt;
  text?: string;
  reason: string;
}

/** Fast local policy for rare, short friend-like overlaps. It never calls the conversation LLM. */
export function classifyNaviInterrupt(evidence: NaviInterruptEvidence): NaviInterruptDecision {
  if (evidence.durationMs < 850) return { type: 'NONE', reason: 'too early' };
  const text = evidence.text.replace(/[\s,、。]/g, '');
  const largePrice = /(?:\d{2,}万|\d{5,}円)/.test(text);
  const price = largePrice || /(?:\d{4,}円|高すぎ|高いな|高かった)/.test(text);
  const repeat = /(?:また.{0,8}買|またやっ|また同じ|何回目)/.test(text);
  const surprising = /(?:嘘でしょ|まじで|ありえな|全滅|大失敗)/.test(text);

  if (largePrice) return { type: 'SOFT_INTERRUPT', text: '高っ', reason: 'large price' };
  if (evidence.level === 'LOW') return { type: 'NONE', reason: 'low frequency' };
  if (repeat) return { type: 'SOFT_INTERRUPT', text: 'またですか', reason: 'running joke' };
  if (price) return { type: 'SOFT_INTERRUPT', text: '高いですね', reason: 'price reaction' };
  if (surprising && evidence.level === 'HIGH') return { type: 'SOFT_INTERRUPT', text: 'えっ', reason: 'strong surprise' };
  return { type: 'NONE', reason: 'no strong cue' };
}
