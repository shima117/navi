import type { AudioSource } from './AudioSource';
import { classifyUserSpeech, type InterruptionEvidence, type UserSpeechIntent } from './InterruptionClassifier';

export type FloorState =
  | 'SILENCE'
  | 'USER_SPEAKING'
  | 'NAVI_SPEAKING'
  | 'USER_BACKCHANNEL'
  | 'NAVI_BACKCHANNEL'
  | 'OVERLAP'
  | 'USER_TAKEOVER'
  | 'NAVI_TAKEOVER';

export interface FloorActions {
  fadeNavi(ms: number): void;
  discardPendingChunks(): void;
  stopLipSync(): void;
  markInterrupted(): void;
  onState?(state: FloorState): void;
}

export const TAKEOVER_FADE_MS = 150;

export class FloorManager {
  private _state: FloorState = 'SILENCE';
  private naviSpeaking = false;
  private userSpeaking = false;
  private lastIntent: UserSpeechIntent | null = null;

  constructor(private readonly actions: FloorActions) {}

  get state(): FloorState {
    return this._state;
  }

  get userIntent(): UserSpeechIntent | null {
    return this.lastIntent;
  }

  naviStarted(backchannel = false): void {
    this.naviSpeaking = true;
    this.set(backchannel ? 'NAVI_BACKCHANNEL' : this.userSpeaking ? 'OVERLAP' : 'NAVI_SPEAKING');
  }

  naviFinished(): void {
    this.naviSpeaking = false;
    this.set(this.userSpeaking ? 'USER_SPEAKING' : 'SILENCE');
  }

  userSpeechStarted(source: AudioSource): void {
    if (source !== 'USER_MIC') return;
    this.userSpeaking = true;
    this.lastIntent = null;
    this.set(this.naviSpeaking ? 'OVERLAP' : 'USER_SPEAKING');
  }

  userPartial(evidence: InterruptionEvidence, source: AudioSource): UserSpeechIntent | null {
    if (source !== 'USER_MIC') return null;
    const intent = classifyUserSpeech(evidence);
    this.lastIntent = intent;
    if (intent === 'BACKCHANNEL') {
      this.set(this.naviSpeaking ? 'USER_BACKCHANNEL' : 'USER_SPEAKING');
      return intent;
    }
    if (intent === 'TAKEOVER' && this.naviSpeaking) {
      this.set('USER_TAKEOVER');
      this.actions.fadeNavi(TAKEOVER_FADE_MS);
      this.actions.discardPendingChunks();
      this.actions.stopLipSync();
      this.actions.markInterrupted();
      this.naviSpeaking = false;
      return intent;
    }
    this.set(this.naviSpeaking ? 'OVERLAP' : 'USER_SPEAKING');
    return intent;
  }

  userSpeechEnded(source: AudioSource): void {
    if (source !== 'USER_MIC') return;
    this.userSpeaking = false;
    this.set(this.naviSpeaking ? 'NAVI_SPEAKING' : 'SILENCE');
  }

  naviTakeoverStarted(): void {
    this.naviSpeaking = true;
    this.set('NAVI_TAKEOVER');
  }

  /** A soft interrupt yields immediately when the user keeps the floor. */
  userContinuedAfterNaviInterrupt(): boolean {
    if (this._state !== 'NAVI_TAKEOVER' && this._state !== 'OVERLAP') return false;
    this.actions.fadeNavi(100);
    this.actions.discardPendingChunks();
    this.naviSpeaking = false;
    this.set('USER_SPEAKING');
    return true;
  }

  canStartNormalSpeech(): boolean {
    return this._state === 'SILENCE' || this._state === 'USER_BACKCHANNEL';
  }

  private set(state: FloorState): void {
    if (this._state === state) return;
    this._state = state;
    this.actions.onState?.(state);
  }
}

