/**
 * Diagnostics must never carry what the user or Navi said, nor screen images
 * (design doc §20). Conversation is Japanese, so any text that comes from
 * outside our own code (child-process stderr, exception messages) has every
 * CJK run replaced and long base64-like blobs dropped before it is kept.
 * Our own diagnostic messages are plain ASCII, so nothing useful is lost.
 */
const CJK_RUN = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]+/g;
const BASE64_BLOB = /[A-Za-z0-9+/=]{120,}/g;
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;

export const REDACTED = '…';

export function redactExternalText(text: string, maxChars = 240): string {
  const clean = text
    .replace(ANSI_ESCAPE, '')
    .replace(CONTROL, ' ')
    .replace(BASE64_BLOB, '[data]')
    .replace(CJK_RUN, REDACTED)
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}${REDACTED}` : clean;
}

/** Message of an unknown thrown value, already redacted. */
export function errorMessage(err: unknown, maxChars = 200): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redactExternalText(raw, maxChars);
}
