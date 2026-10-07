const BACKCHANNELS = new Set([
  'うん',
  'うんうん',
  'へえ',
  'へー',
  'あー',
  'あーね',
  'はい',
  'そうそう',
  'そうなんだ',
  'なるほど',
  'まじか',
  'ふーん',
  'ふんふん',
  'ほう',
]);

const AMBIGUOUS = new Set(['いや', 'え', 'あ', '待って', 'ちょっと']);
const TAKEOVER = [
  /^(?:いや\s*)?(?:ちょっと\s*)?待って/,
  /^いや(?:、|\s)*(?:違う|そうじゃ|それは)/,
  /^(?:それ|そこ)(?:、|\s)*(?:違う|じゃない)/,
  /^(?:違う|訂正)/,
  /止めて|ストップ/,
];

export type UserSpeechIntent = 'BACKCHANNEL' | 'AMBIGUOUS' | 'TAKEOVER' | 'CONTINUE';

export interface InterruptionEvidence {
  text: string;
  durationMs: number;
  /** 0..1 relative energy compared with the user's recent speech. */
  energy: number;
  final: boolean;
}

function normalize(text: string): string {
  return text
    .trim()
    .replace(/[。！!？?、,]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function classifyUserSpeech(evidence: InterruptionEvidence): UserSpeechIntent {
  const text = normalize(evidence.text);
  if (TAKEOVER.some((pattern) => pattern.test(text))) return 'TAKEOVER';
  if (BACKCHANNELS.has(text) && evidence.durationMs <= 1_300) return 'BACKCHANNEL';
  if ((!evidence.final || evidence.durationMs < 350) && AMBIGUOUS.has(text)) return 'AMBIGUOUS';
  if (evidence.durationMs >= 900 || text.length >= 7 || evidence.energy >= 0.82) return 'TAKEOVER';
  if (!evidence.final) return 'AMBIGUOUS';
  return text.length <= 3 ? 'AMBIGUOUS' : 'CONTINUE';
}

export function isBackchannelText(text: string): boolean {
  return BACKCHANNELS.has(normalize(text));
}

