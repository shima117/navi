import type {
  CompanionResponse,
  PerformanceCue,
  PluginContext,
  PluginEvent,
  ScreenObservation,
  UserUtterance,
} from '../types';
import type { FrameSummary } from '../screen/FrameSummary';
import type { ScreenOcr } from '../screen/OcrAnalysis';
import type { LipSyncKeyframe } from '../voice/LipSync';

/** Every event in the system (design doc §16). Modules talk only through these. */
export interface NaviEvents {
  'screen.frame': FrameSummary;
  'screen.changed': FrameSummary;
  'screen.observed': ScreenObservation;
  /** Short OCR summary of a high-change frame (RAM only; never log or persist the text, §20). */
  'screen.ocr': ScreenOcr;

  'voice.speech_started': { at: number };
  'voice.transcript': UserUtterance;
  'voice.interrupted': { at: number };

  'plugin.event': PluginEvent;
  'plugin.context': PluginContext;

  'friend.response': CompanionResponse;
  'friend.speak': { text: string; cue: PerformanceCue };
  'friend.silent': { reason: string };

  'avatar.performance': PerformanceCue;
  'avatar.lipsync': { keyframes: LipSyncKeyframe[] };

  'memory.write': { text: string; tier: 'session' | 'long' };
  'session.started': { at: number };
  'session.ended': { at: number };

  'health.changed': { service: ServiceName; ok: boolean };
}

export type ServiceName = 'chat' | 'vision' | 'stt' | 'tts' | 'avatar';

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof NaviEvents, Set<Handler<never>>>();

  on<K extends keyof NaviEvents>(type: K, handler: Handler<NaviEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  /**
   * Handlers run synchronously; a throwing handler is logged and isolated so
   * one broken module cannot take down the others (design doc §19).
   */
  emit<K extends keyof NaviEvents>(type: K, payload: NaviEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as Handler<NaviEvents[K]>)(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${type}" failed:`, err);
      }
    }
  }
}
