import { FADE_OUT_MS } from '../core/voice/BargeIn';

type LipSyncFrames = Array<{ t: number; open: number; form: number }>;

/** Plays TTS audio with a gain node so barge-in can fade it out (§11.2). */
export class SpeechPlayer {
  private ctx: AudioContext | null = null;
  private current: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

  async play(audio: ArrayBuffer, lipsync: LipSyncFrames): Promise<void> {
    this.stop(0);
    this.ctx ??= new AudioContext();
    const buffer = await this.ctx.decodeAudioData(audio.slice(0));
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.buffer = buffer;
    source.connect(gain).connect(this.ctx.destination);
    const entry = { source, gain };
    this.current = entry;
    source.onended = () => {
      if (this.current === entry) {
        this.current = null;
        window.navi.voice.playback('finished');
      }
    };
    window.navi.voice.playback('started');
    window.navi.avatar.forwardLipSync(lipsync);
    source.start();
  }

  stop(fadeMs = FADE_OUT_MS): void {
    const cur = this.current;
    if (!cur || !this.ctx) return;
    this.current = null;
    const t = this.ctx.currentTime;
    cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
    cur.gain.gain.linearRampToValueAtTime(0, t + fadeMs / 1000);
    cur.source.stop(t + fadeMs / 1000 + 0.01);
    window.navi.avatar.forwardLipSync(null);
    window.navi.voice.playback('finished');
  }
}
