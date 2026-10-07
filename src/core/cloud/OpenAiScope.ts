import { createHash } from 'node:crypto';
import { OPENAI_MODELS, OPENAI_OUTPUT_LIMIT, OPENAI_RATE_VERSION, type OpenAiTextInput, type OpenAiTier, type CloudDataClass, quoteOpenAi } from './OpenAiOptions';

export const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
export const CLOUD_CONSENT_TTL = 10 * 60 * 1000;
export interface OpenAiPayload {
  provider: 'OPENAI';
  model: string;
  tier: OpenAiTier;
  dataClass: CloudDataClass;
  reason: 'USER_EXPLICITLY_REQUESTED';
  textHash: string;
  inputText?: string; // RAM only; omitted from Task DB.
  maxOutputTokens: number;
  maxCostMicros: number;
  quotedMicros: number;
  rateVersion: string;
}
export interface CloudConsent {
  id: string;
  taskId: string;
  fingerprint: string;
  grantedAt: number;
  expiresAt: number;
}
export function textHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function makeOpenAiPayload(input: OpenAiTextInput): OpenAiPayload {
  const quotedMicros = quoteOpenAi(input);
  if (quotedMicros > input.maxCostMicros) throw new Error('概算の安全側見積もりが、この作業の料金上限を超えています。');
  return { provider: 'OPENAI', model: OPENAI_MODELS[input.tier].model, tier: input.tier, dataClass: input.dataClass,
    reason: 'USER_EXPLICITLY_REQUESTED', textHash: textHash(input.text), inputText: input.text, maxOutputTokens: OPENAI_OUTPUT_LIMIT,
    maxCostMicros: input.maxCostMicros, quotedMicros, rateVersion: OPENAI_RATE_VERSION };
}
export function validOpenAiPayload(payload: OpenAiPayload | undefined): boolean {
  if (!payload || typeof payload.inputText !== 'string') return false;
  try {
    const expected = makeOpenAiPayload({ text: payload.inputText, tier: payload.tier, dataClass: payload.dataClass, maxCostMicros: payload.maxCostMicros });
    return Object.keys(payload).every((key) => Object.prototype.hasOwnProperty.call(expected, key))
      && Object.entries(expected).every(([key, value]) => payload[key as keyof OpenAiPayload] === value);
  } catch { return false; }
}
export function cloudFingerprint(taskId: string, payload: OpenAiPayload): string {
  const scope = Object.keys(payload).filter((key) => key !== 'inputText').sort().map((key) => [key, payload[key as keyof OpenAiPayload]]);
  return createHash('sha256').update(JSON.stringify([taskId, OPENAI_ENDPOINT, scope])).digest('hex');
}
