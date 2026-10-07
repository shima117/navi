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
import type { ResourceMode } from '../resource/ResourceGovernor';
import type { AudioSource } from '../voice/AudioSource';
import type { FloorState } from '../voice/FloorManager';
import type { TaskSnapshot } from '../tasks/TaskSnapshotPublisher';
import type { OperationReport } from '../tasks/OperationReport';

/** Every event in the system (design doc §16). Modules talk only through these. */
export interface NaviEvents {
  'screen.frame': FrameSummary;
  'screen.changed': FrameSummary;
  'screen.observed': ScreenObservation;
  /** Short OCR summary of a high-change frame (RAM only; never log or persist the text, §20). */
  'screen.ocr': ScreenOcr;

  'voice.speech_started': { at: number; source?: AudioSource };
  'voice.speech_ended': { at: number; source?: AudioSource };
  'voice.partial': { at: number; source: AudioSource; text: string; durationMs: number; energy: number };
  'voice.floor_changed': { at: number; state: FloorState };
  'voice.transcript': UserUtterance;
  'voice.interrupted': { at: number };
  'audio.system_event': { at: number; kind: string; confidence: number };
  'audio.system_transcript': { at: number; text: string };
  'audio.remote_transcript': { at: number; text: string };

  'plugin.event': PluginEvent;
  'plugin.context': PluginContext;

  'friend.response': CompanionResponse;
  'friend.speak': { text: string; cue: PerformanceCue; presentation?: 'voice' | 'text' | 'both'; textMode?: 'ANSWER' | 'TASK_STATUS' };
  'task.snapshot': { snapshot: TaskSnapshot; report?: OperationReport };
  'friend.silent': { reason: string };

  'avatar.performance': PerformanceCue;
  'avatar.lipsync': { keyframes: LipSyncKeyframe[] };

  'memory.write': { text: string; tier: 'session' | 'long' };
  'session.started': { at: number };
  'session.ended': { at: number };

  'health.changed': { service: ServiceName; ok: boolean };

  // Local-only metrics (PR-10). Payloads never carry transcript text or images.
  'metrics.timing': { kind: TimingKind; ms: number; at: number };
  'metrics.error': { service: string; message: string; at: number };
  'metrics.initiative': { speak: boolean; reason: string; at: number };
  'resource.mode': { mode: ResourceMode; auto: boolean; reason: string; at: number };
}

export type ServiceName = 'chat' | 'vision' | 'stt' | 'tts' | 'avatar';

/** response = user utterance → Navi speech start (§23.3); the others are per-call latencies. */
export type TimingKind = 'response' | 'chat' | 'vision' | 'tts';

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
