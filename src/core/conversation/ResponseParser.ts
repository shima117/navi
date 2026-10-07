import {
  EMOTIONS,
  GESTURES,
  type CompanionResponse,
  type Emotion,
  type Gaze,
  type Gesture,
  type Temperature,
  type TopicAction,
} from '../types';

export const SILENT_RESPONSE: CompanionResponse = {
  speak: false,
  text: '',
  temperature: 'thin',
  emotion: 'neutral',
  intensity: 0,
  gaze: 'screen',
  gesture: 'still',
  memory_write: [],
  topic_action: 'continue',
  needs_vision: false,
  needs_tool: null,
};

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/**
 * Turn raw model output into a valid CompanionResponse. Unknown enum values
 * fall back to safe defaults. Plain text (model ignored the schema) is treated
 * as speech so a slightly disobedient model still works.
 */
export function parseCompanionResponse(raw: string): CompanionResponse {
  const json = extractJsonObject(raw);
  let obj: Record<string, unknown> | null = null;
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
    } catch {
      obj = null;
    }
  }
  if (!obj) {
    const text = raw.trim();
    return text ? { ...SILENT_RESPONSE, speak: true, text, temperature: 'normal' } : { ...SILENT_RESPONSE };
  }

  const text = typeof obj.text === 'string' ? obj.text.trim() : '';
  const intensity = typeof obj.intensity === 'number' && Number.isFinite(obj.intensity) ? obj.intensity : 0.4;
  const tool = obj.needs_tool;
  return {
    speak: obj.speak === false ? false : text.length > 0,
    text,
    temperature: pick<Temperature>(obj.temperature, ['thin', 'normal', 'dense'], 'normal'),
    emotion: pick<Emotion>(obj.emotion, EMOTIONS, 'neutral'),
    intensity: Math.min(1, Math.max(0, intensity)),
    gaze: pick<Gaze>(obj.gaze, ['screen', 'user', 'away'], 'user'),
    gesture: pick<Gesture>(obj.gesture, GESTURES, 'still'),
    memory_write: Array.isArray(obj.memory_write)
      ? obj.memory_write.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      : [],
    topic_action: pick<TopicAction>(obj.topic_action, ['continue', 'shift', 'drop'], 'continue'),
    needs_vision: obj.needs_vision === true,
    needs_tool:
      tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string'
        ? { name: (tool as { name: string }).name, args: (tool as { args?: unknown }).args ?? {} }
        : null,
  };
}
