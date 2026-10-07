export interface FakeService<S> {
  /** Request counters, for assertions. */
  stats: S;
  /** Stop listening and drop open connections. */
  close(): Promise<void>;
}

export declare const OLLAMA_PORT: number;
export declare const VOICEVOX_PORT: number;
export declare function startFakeOllama(port?: number): Promise<FakeService<{ chat: number; requests: number }>>;
export declare function startFakeVoicevox(port?: number): Promise<FakeService<{ synthesis: number; requests: number }>>;
