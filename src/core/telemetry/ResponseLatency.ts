import type { TimingKind } from '../events/EventBus';

/**
 * Measures "user finished talking → Navi starts talking" (§23.3, target < 2 s)
 * and TTS latency (speak decision → audio playback start).
 *
 * Speech start is when audio playback begins; when TTS is down the subtitle
 * is the speech, so the speak decision itself counts (§19). Initiative speech
 * (nobody asked) yields a TTS sample but no response sample.
 */
export interface ResponseLatencyOptions {
  /** Samples older than this are dropped (TTS failed, playback never started, …). */
  maxWaitMs?: number;
  /** A transcript may arrive this long after the VAD end-of-speech it belongs to. */
  maxSttMs?: number;
}

export class ResponseLatencyTracker {
  private lastSpeechEndAt: number | null = null;
  private pendingUserAt: number | null = null;
  private awaitingPlayback: { speakAt: number; userAt: number | null } | null = null;
  private readonly maxWaitMs: number;
  private readonly maxSttMs: number;

  constructor(
    private readonly emit: (kind: TimingKind, ms: number) => void,
    opts: ResponseLatencyOptions = {},
  ) {
    this.maxWaitMs = opts.maxWaitMs ?? 30_000;
    this.maxSttMs = opts.maxSttMs ?? 15_000;
  }

  /** VAD end-of-speech from the voice service. */
  userSpeechEnded(at: number): void {
    this.lastSpeechEndAt = at;
  }

  /**
   * A user turn. For voice the clock starts at end-of-speech so STT time is
   * included; a newer turn replaces an unanswered one (it supersedes it).
   */
  userUtterance(at: number, source: 'voice' | 'text'): void {
    const end = this.lastSpeechEndAt;
    const fromSpeechEnd = source === 'voice' && end !== null && at >= end && at - end <= this.maxSttMs;
    this.pendingUserAt = fromSpeechEnd ? end : at;
    this.lastSpeechEndAt = null;
  }

  /** Navi decided to speak. `audio` = TTS is expected to play it. */
  naviSpeak(at: number, audio: boolean): void {
    const userAt = this.pendingUserAt !== null && at - this.pendingUserAt <= this.maxWaitMs ? this.pendingUserAt : null;
    this.pendingUserAt = null;
    if (!audio) {
      this.awaitingPlayback = null;
      if (userAt !== null) this.emit('response', at - userAt);
      return;
    }
    this.awaitingPlayback = { speakAt: at, userAt };
  }

  /** Navi chose not to answer: nothing to measure for that turn. */
  naviSilent(): void {
    this.pendingUserAt = null;
  }

  /** Audio playback started in the renderer. */
  playbackStarted(at: number): void {
    const w = this.awaitingPlayback;
    this.awaitingPlayback = null;
    if (!w || at - w.speakAt > this.maxWaitMs || at < w.speakAt) return;
    this.emit('tts', at - w.speakAt);
    if (w.userAt !== null) this.emit('response', at - w.userAt);
  }
}
