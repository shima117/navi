/** Public configuration, never credentials. Rates reviewed against official pages on 2026-10-07. */
export const OPENAI_MODELS = {
  ECONOMY: { model: 'gpt-6-luna', label: 'Economy（軽い確認）', inputUsdPerMillion: .10, outputUsdPerMillion: .50 },
  STANDARD: { model: 'gpt-6.1-sol', label: 'Standard（標準）', inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  EXPERT: { model: 'gpt-6-astra', label: 'Expert（難しい確認）', inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
} as const;
export type OpenAiTier = keyof typeof OPENAI_MODELS;
export type CloudDataClass = 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL' | 'SECRET';
export interface OpenAiTextInput {
  text: string;
  tier: OpenAiTier;
  dataClass: CloudDataClass;
  maxCostMicros: number;
}
export const OPENAI_OUTPUT_LIMIT = 1024;
export const OPENAI_INPUT_BYTE_LIMIT = 2048;
export const OPENAI_RATE_VERSION = '2026-10-07';
export const OPENAI_RATES_EXPIRE = Date.parse('2026-11-06T00:00:00Z');
export const OPENAI_LIMITS = { taskMicros: 250000, dayMicros: 1000000, monthMicros: 10000000 } as const;
export const OPENAI_INSTRUCTIONS = 'Answer the user request in Japanese. No tool use or actions. Do not claim that you executed or verified code, files, or PC operations.';
export function usd(micros: number): string { return '$' + (micros / 1e6).toFixed(6); }
export function validateOpenAiInput(value: unknown): asserts value is OpenAiTextInput {
  if (!value || typeof value !== 'object') throw new Error('OpenAIへの送信内容を指定してください。');
  const v = value as OpenAiTextInput;
  if (Object.keys(v).some((key) => !['text', 'tier', 'dataClass', 'maxCostMicros'].includes(key))
    || !Object.prototype.hasOwnProperty.call(OPENAI_MODELS, v.tier)
    || typeof v.text !== 'string' || !v.text.trim() || new TextEncoder().encode(v.text).length > OPENAI_INPUT_BYTE_LIMIT
    || v.text.split('\n').length > 24 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v.text)
    || !['PUBLIC', 'PRIVATE'].includes(v.dataClass)
    || !Number.isSafeInteger(v.maxCostMicros) || v.maxCostMicros <= 0 || v.maxCostMicros > OPENAI_LIMITS.taskMicros)
    throw new Error('送信できるのは公開・個人用の短い文章だけです。機密・秘密情報、上限超過、未対応の設定は送信できません。');
  // Defense in depth, not a complete secret detector. Reject rather than silently change the approved payload.
  if (/sk-[a-z0-9_-]{12,}|(?:ghp_|github_pat_|xox[baprs]-)[a-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*\S{6,}/i.test(v.text))
    throw new Error('秘密情報らしい文字列があります。APIキーやパスワードを除いてください。');
}
/** Conservative estimate, not a provider billing guarantee or an exact tokenizer. */
export function quoteOpenAi(input: OpenAiTextInput): number {
  validateOpenAiInput(input);
  const rates = OPENAI_MODELS[input.tier];
  // UTF-8 byte-based upper estimate plus generous message/instruction overhead.
  const inputTokens = new TextEncoder().encode(input.text + OPENAI_INSTRUCTIONS).length + 4096;
  // Allow cache-write pricing (1.25x input) and a regional premium (1.1x).
  return Math.ceil((inputTokens * rates.inputUsdPerMillion * 1.25 + OPENAI_OUTPUT_LIMIT * rates.outputUsdPerMillion) * 1.1);
}
export interface OpenAiCloudState {
  keyConfigured: boolean;
  limits: typeof OPENAI_LIMITS;
  dayChargedMicros: number;
  monthChargedMicros: number;
  ratesExpireAt: number;
}
