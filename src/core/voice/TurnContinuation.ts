const FILLER_END = /(?:えー|えっと|その|あの|なんか|まあ|ていうか|というか|で|けど|から|さ)[…\.\s]*$/;
const COMPLETE_END = /(?:です|ます|でした|ました|だ|だった|ない|ある|いる|思う|なった|した|する|？|\?|！|!|。)[\s]*$/;

export interface TurnContinuationEvidence {
  text: string;
  pauseMs: number;
  final: boolean;
}

export interface TurnContinuationResult {
  pauseMs: number;
  syntaxComplete: number;
  fillerProbability: number;
  semanticComplete: number;
  continuationProbability: number;
  endTurn: boolean;
}

export function assessTurnContinuation(evidence: TurnContinuationEvidence): TurnContinuationResult {
  const text = evidence.text.trim();
  const fillerProbability = FILLER_END.test(text) ? 0.9 : /[…\.]{2,}$/.test(text) ? 0.68 : 0.08;
  const syntaxComplete = COMPLETE_END.test(text) ? 0.88 : text.length > 12 ? 0.46 : 0.2;
  const semanticComplete = evidence.final ? Math.max(0.55, syntaxComplete) : syntaxComplete * 0.7;
  const pausePressure = evidence.pauseMs < 300 ? 0.95 : evidence.pauseMs < 650 ? 0.62 : evidence.pauseMs < 1_100 ? 0.3 : 0.08;
  const continuationProbability = Math.max(0, Math.min(1, fillerProbability * 0.55 + pausePressure * 0.35 + (1 - semanticComplete) * 0.25));
  const requiredPause = continuationProbability >= 0.7 ? 1_200 : continuationProbability >= 0.45 ? 900 : 550;
  return {
    pauseMs: evidence.pauseMs,
    syntaxComplete,
    fillerProbability,
    semanticComplete,
    continuationProbability,
    endTurn: evidence.final && evidence.pauseMs >= requiredPause,
  };
}

