/**
 * Barge-in state machine (design doc §11.2).
 *
 * idle ──speak──▶ navi_speaking ──user voice──▶ interrupted ──fade done──▶ user_speaking
 *  ▲                    │                                                        │
 *  └────speech ended────┴──────────────────────── user speech ended ─────────────┘
 */
export type VoiceState = 'idle' | 'navi_speaking' | 'interrupted' | 'user_speaking';

export interface BargeInActions {
  /** Fade TTS output out over the given ms. */
  fadeOut(ms: number): void;
  /** Stop lip sync immediately. */
  stopMouth(): void;
  /** Record the unfinished Navi turn as interrupted. */
  markInterrupted(): void;
}

export const FADE_OUT_MS = 150;

export class BargeInController {
  private _state: VoiceState = 'idle';

  constructor(private readonly actions: BargeInActions) {}

  get state(): VoiceState {
    return this._state;
  }

  naviStarted(): void {
    // Never talk over a user who is already speaking.
    if (this._state === 'user_speaking') return;
    this._state = 'navi_speaking';
  }

  naviFinished(): void {
    if (this._state === 'navi_speaking') this._state = 'idle';
  }

  userSpeechStarted(): void {
    if (this._state === 'navi_speaking') {
      this._state = 'interrupted';
      this.actions.fadeOut(FADE_OUT_MS);
      this.actions.stopMouth();
      this.actions.markInterrupted();
    }
    this._state = 'user_speaking';
  }

  userSpeechEnded(): void {
    if (this._state === 'user_speaking') this._state = 'idle';
  }

  /** Navi may begin speaking only when nobody else is. */
  canSpeak(): boolean {
    return this._state === 'idle';
  }
}
