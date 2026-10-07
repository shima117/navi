import type { VoiceServiceEvent } from '../../electron/ipc';

const VOICE_WS = 'ws://127.0.0.1:17650/ws';
const TARGET_RATE = 16_000;

// Downsamples mic audio to 16 kHz mono Int16 and posts ~32 ms chunks.
const WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = sampleRate / ${TARGET_RATE};
    this.acc = 0;
    this.buf = new Int16Array(512);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const s = Math.max(-1, Math.min(1, ch[i]));
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.buffer.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

/**
 * Streams the microphone to navi-voice-service (VAD + faster-whisper) and
 * relays its events to main. If the service is down, text input still works.
 */
export class VoiceClient {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly onStatus: (connected: boolean) => void) {}

  async start(deviceId: string | null): Promise<void> {
    await this.stop();
    this.running = true;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
    this.ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, 'pcm-tap');
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data);
    };
    src.connect(node);
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.onStatus(false);
  }

  private connect(attempt = 0): void {
    if (!this.running) return;
    const ws = new WebSocket(VOICE_WS);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      attempt = 0;
      this.onStatus(true);
    };
    ws.onmessage = (e) => {
      try {
        window.navi.voice.sendEvent(JSON.parse(String(e.data)) as VoiceServiceEvent);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      this.onStatus(false);
      if (!this.running) return;
      const delays = [1000, 2000, 5000, 10000, 30000];
      this.reconnectTimer = setTimeout(() => this.connect(attempt + 1), delays[Math.min(attempt, delays.length - 1)]);
    };
    this.ws = ws;
  }
}
