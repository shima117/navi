/**
 * Minimal Ollama HTTP client (localhost only, design doc §18).
 * Uses global fetch so it runs in Electron main and in tests.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Base64 images (no data: prefix) for vision models. */
  images?: string[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** 'json' or a JSON schema object for structured output. */
  format?: 'json' | Record<string, unknown>;
  keepAlive?: string | number;
  options?: { temperature?: number; num_ctx?: number; num_predict?: number };
  signal?: AbortSignal;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class OllamaClient {
  constructor(
    private readonly baseUrl = 'http://127.0.0.1:11434',
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
  ) {}

  async chat(req: ChatRequest): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        format: req.format,
        keep_alive: req.keepAlive,
        options: req.options,
        stream: false,
      }),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${await res.text().catch(() => '')}`);
    const body = (await res.json()) as { message?: { content?: string } };
    return body.message?.content ?? '';
  }

  /** Lightweight liveness check. */
  async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/version`, { signal });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Unload a model immediately to give VRAM back to the game. */
  async unload(model: string): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    }).catch(() => undefined);
  }
}
