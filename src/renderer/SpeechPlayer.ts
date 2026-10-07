import { FADE_OUT_MS } from '../core/voice/BargeIn';

type LipSyncFrames = Array<{ t: number; open: number; form: number }>;

interface QueuedSpeech {
  audio: ArrayBuffer;
  lipsync: LipSyncFrames;
  backchannel: boolean;
  interrupt: boolean;
}

export interface OutputSelection {
  status: 'connected' | 'missing' | 'fallback';
  deviceId: string | null;
  label: string | null;
}

type SinkAudioContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

const VAIO3_NAMES = ['voicemeeter vaio3', 'vaio3 input', 'vb-audio voicemeeter vaio3'];

/** Chunked TTS player with fade-out and explicit VAIO3 output selection. */
export class SpeechPlayer {
  private ctx: SinkAudioContext | null = null;
  private current: { source: AudioBufferSourceNode; gain: GainNode; backchannel: boolean; interrupt: boolean } | null = null;
  private queue: QueuedSpeech[] = [];
  private output: OutputSelection = { status: 'missing', deviceId: null, label: null };

  get outputSelection(): OutputSelection {
    return this.output;
  }

  async configureOutput(preferredName = 'Voicemeeter VAIO3 Input', fallbackDeviceId: string | null = null): Promise<OutputSelection> {
    this.ctx ??= new AudioContext() as SinkAudioContext;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const wanted = preferredName.toLowerCase();
    const match = devices.find((d) => {
      const label = d.label.toLowerCase();
      return label.includes(wanted) || VAIO3_NAMES.some((token) => label.includes(token));
    });
    const fallback = fallbackDeviceId ? devices.find((d) => d.deviceId === fallbackDeviceId) : null;
    const selected = match ?? fallback ?? devices.find((d) => d.deviceId === 'default') ?? null;
    if (selected && this.ctx.setSinkId) {
      try {
        await this.ctx.setSinkId(selected.deviceId);
      } catch (err) {
        console.warn('[speech] output selection failed', err);
      }
    }
    this.output = match
      ? { status: 'connected', deviceId: match.deviceId, label: match.label }
      : { status: selected ? 'fallback' : 'missing', deviceId: selected?.deviceId ?? null, label: selected?.label ?? null };
    return this.output;
  }

  async play(audio: ArrayBuffer, lipsync: LipSyncFrames, backchannel = false): Promise<void> {
    this.stop(0);
    await this.enqueue(audio, lipsync, backchannel);
  }

  async enqueue(audio: ArrayBuffer, lipsync: LipSyncFrames, backchannel = false, interrupt = false): Promise<void> {
    this.queue.push({ audio: audio.slice(0), lipsync, backchannel, interrupt });
    if (!this.current) await this.playNext();
  }

  discardPending(): void {
    this.queue = [];
  }

  stop(fadeMs = FADE_OUT_MS): void {
    this.discardPending();
    const cur = this.current;
    if (!cur || !this.ctx) return;
    this.current = null;
    const t = this.ctx.currentTime;
    cur.gain.gain.cancelScheduledValues(t);
    cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
    cur.gain.gain.linearRampToValueAtTime(0, t + fadeMs / 1000);
    cur.source.stop(t + fadeMs / 1000 + 0.01);
    window.navi.avatar.forwardLipSync(null);
    window.navi.voice.playback({ state: 'finished', backchannel: cur.backchannel, mode: playbackMode(cur) });
  }

  private async playNext(): Promise<void> {
    const item = this.queue.shift();
    if (!item) {
      window.navi.voice.playback({ state: 'finished', backchannel: false });
      return;
    }
    this.ctx ??= new AudioContext() as SinkAudioContext;
    const buffer = await this.ctx.decodeAudioData(item.audio);
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.buffer = buffer;
    source.connect(gain).connect(this.ctx.destination);
    const entry = { source, gain, backchannel: item.backchannel, interrupt: item.interrupt };
    this.current = entry;
    source.onended = () => {
      if (this.current !== entry) return;
      this.current = null;
      if (!item.backchannel) window.navi.avatar.forwardLipSync(null);
      if (this.queue.length) void this.playNext();
      else window.navi.voice.playback({ state: 'finished', backchannel: item.backchannel, mode: playbackMode(item) });
    };
    window.navi.voice.playback({ state: 'started', backchannel: item.backchannel, mode: playbackMode(item) });
    if (!item.backchannel) window.navi.avatar.forwardLipSync(item.lipsync);
    source.start();
  }
}

function playbackMode(item: { backchannel: boolean; interrupt: boolean }): 'normal' | 'backchannel' | 'interrupt' {
  return item.interrupt ? 'interrupt' : item.backchannel ? 'backchannel' : 'normal';
}
