import type { TaskOutcome, TaskRunner } from '../tasks/TaskEngine';
import { OPENAI_INSTRUCTIONS, OPENAI_MODELS } from './OpenAiOptions';
import { OPENAI_ENDPOINT } from './OpenAiScope';
import type { OpenAiLedger } from './OpenAiLedger';

const failed = (reason: string): TaskOutcome => ({ state: 'FAILED', summary: 'OpenAIの回答を確認できませんでした。', reason,
  nextAction: '自動再送はしません。利用記録を確認してから、必要なら新しい作業として依頼してください。',
  verification: { method: 'HTTP', result: 'FAIL', evidence: 'No verified completed text response.' } });
type ApiResponse = {
  id?: string; status?: string; model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  output?: Array<{ type?: string; role?: string; status?: string; content?: Array<{ type?: string; text?: string }> }>;
};

/** Fixed endpoint, no SDK retries, no tools, no history. Dependency injection is test-only. */
export function openAiRunner(ledger: OpenAiLedger, key: () => string | undefined, transport: typeof fetch = fetch): TaskRunner {
  return async (request, signal, progress) => {
    const credential = key();
    if (!credential || /[\r\n]/.test(credential)) return failed('起動時のOPENAI_API_KEYが未設定か、不正です。');
    if (signal.aborted) return failed('送信前に中止されました。');
    try { ledger.dispatch(request); } catch { return failed('承認・料金上限・有効期限の確認が通らなかったため、送信しませんでした。'); }
    const cloud = request.cloud!;
    progress('OpenAIの回答を待っています（送信後の中止でも課金される可能性があります）。', .1);
    try {
      const response = await transport(OPENAI_ENDPOINT, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cloud.model, input: cloud.inputText, instructions: OPENAI_INSTRUCTIONS,
          max_output_tokens: cloud.maxOutputTokens, reasoning: { effort: 'low' },
          store: false, service_tier: 'default', tools: [], tool_choice: 'none' }),
      });
      if (!response.ok) { await response.body?.cancel(); return failed('OpenAIから正常な応答がありませんでした。課金状態は未確認です。'); }
      const reader = response.body?.getReader();
      if (!reader) return failed('応答本文がありません。課金状態は未確認です。');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          if (signal.aborted) throw new Error('ABORTED');
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 1024 * 1024) throw new Error('OVERSIZED');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined)) as ApiResponse;
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^resp_[a-z0-9_-]{1,120}$/i.test(value.id)
        || typeof value.model !== 'string' || (value.model !== cloud.model && !value.model.startsWith(cloud.model + '-')))
        return failed('要求と一致するAPI応答を確認できませんでした。課金状態は未確認です。');
      const input = value.usage?.input_tokens;
      const output = value.usage?.output_tokens;
      if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input! < 0 || output! < 0
        || input! > 1000000 || output! > 1000000) return failed('利用トークン数を確認できませんでした。見積もり額を未確定として残します。');
      const rates = OPENAI_MODELS[cloud.tier];
      const charged = Math.ceil((input! * rates.inputUsdPerMillion * 1.25 + output! * rates.outputUsdPerMillion) * 1.1);
      ledger.settle(request.id, charged);
      if (charged > cloud.quotedMicros || charged > cloud.maxCostMicros || output! > cloud.maxOutputTokens)
        return failed('利用量が承認時の見積もりを超えました。実績を記録し、この作業は確認未完了として止めます。');
      if (!Array.isArray(value.output) || value.output.some((item) => !item || !['message', 'reasoning'].includes(item.type ?? '')))
        return failed('文章以外の出力を受け取りました。操作は実行しません。');
      const messages = value.output.filter((item) => item.type === 'message');
      if (messages.some((m) => m.role !== 'assistant' || m.status !== 'completed' || !Array.isArray(m.content)
        || m.content.some((part) => !part || part.type !== 'output_text' || typeof part.text !== 'string')))
        return failed('拒否または未完了の回答でした。');
      const text = messages.flatMap((m) => m.content!.map((part) => part.text!)).join('\n');
      if (value.status !== 'completed' || !text.trim() || text.length > 16000)
        return failed('回答が未完了か、表示範囲を超えています。完了とは扱いません。');
      if (signal.aborted) return failed('中止されました。送信済みの利用量は記録しています。');
      return { state: 'SUCCESS', summary: `OpenAIの回答（内容の正しさは未検証）:\n${text}`,
        verification: { method: 'HTTP', result: 'PASS', evidence: `OpenAI response ${value.id}: completed text and usage received; not factual verification.` } };
    } catch {
      // Never surface provider bodies, URLs with credentials, or arbitrary exception messages.
      return failed('通信または応答確認に失敗しました。課金済みの可能性があるため、見積もり額を未確定として残します。');
    }
  };
}
