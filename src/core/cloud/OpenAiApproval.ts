import { OPENAI_INSTRUCTIONS, OPENAI_LIMITS, OPENAI_RATES_EXPIRE, usd, type OpenAiCloudState } from './OpenAiOptions';
import { makeOpenAiPayload, type OpenAiPayload } from './OpenAiScope';

/** Called only by native main. A renderer flag can never bypass the confirmation. */
export async function approveOpenAiText(input: unknown, state: OpenAiCloudState, now: number,
  confirm: (detail: string) => Promise<boolean>, stillValid: () => boolean,
  enqueue: (payload: OpenAiPayload) => string): Promise<string | null> {
  // Canonicalization validates all renderer fields and binds approval to unchanged bytes.
  const payload = makeOpenAiPayload(input as Parameters<typeof makeOpenAiPayload>[0]);
  if (!state.keyConfigured) throw new Error('OPENAI_API_KEYが未設定です。起動環境に設定してNAVIを再起動してください。キーをチャットに貼らないでください。');
  if (now >= OPENAI_RATES_EXPIRE) throw new Error('料金表の確認期限が切れています。更新するまで送信しません。');
  if (state.dayChargedMicros + payload.quotedMicros > OPENAI_LIMITS.dayMicros
    || state.monthChargedMicros + payload.quotedMicros > OPENAI_LIMITS.monthMicros) throw new Error('OpenAIのローカル利用上限に達しています。送信しません。');
  const detail = `送信先: OpenAI Responses API\nモデル: ${payload.model}（この作業で明示選択。自動切替なし）\n分類: ${payload.dataClass}\n概算予約額: ${usd(payload.quotedMicros)} / 作業上限: ${usd(payload.maxCostMicros)}\n日上限: ${usd(OPENAI_LIMITS.dayMicros)} / 月上限: ${usd(OPENAI_LIMITS.monthMicros)}（UTC基準、NAVI内の概算管理。請求保証ではありません）\n承認: この1回だけ、10分間。通信失敗・中止でも課金される可能性があります。自動再送しません。\n保存: store:false。OpenAI側の不正利用監視ログは通常最大30日残る場合があります。回答はNAVIの作業履歴に保存します。\n送らないもの: 雑談履歴、記憶、画面、音声、ファイル。ツール・PC操作なし。\n送信する固定指示:\n${OPENAI_INSTRUCTIONS}\n送信する文章（全文）:\n${payload.inputText}`;
  const allowed = await confirm(detail);
  if (!allowed || !stillValid()) return null;
  return enqueue(payload);
}
