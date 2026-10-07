import { OllamaClient, type ChatRequest } from '../src/core/ai/OllamaClient';

/** Fake Ollama: each call pops the next scripted reply (string or Error). */
export class FakeOllama extends OllamaClient {
  calls: ChatRequest[] = [];
  constructor(private replies: Array<string | Error | ((req: ChatRequest) => string)>) {
    super('http://fake');
  }
  override async chat(req: ChatRequest): Promise<string> {
    this.calls.push(req);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('FakeOllama: no scripted reply');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(req) : next;
  }
}

export const reply = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    speak: true,
    text,
    temperature: 'normal',
    emotion: 'neutral',
    intensity: 0.4,
    gaze: 'user',
    gesture: 'small_nod',
    memory_write: [],
    topic_action: 'continue',
    needs_vision: false,
    needs_tool: null,
    ...extra,
  });
