import { DEFAULT_MANAGED_PROCESSES, type ManagedProcessesSettings } from '../src/core/supervisor/processSpecs';
import type { AudioSource } from '../src/core/voice/AudioSource';
import type { FloorState } from '../src/core/voice/FloorManager';

/** IPC channel names (design doc §17). Shared by main and preload. */
export const IPC = {
  captureListSources: 'capture:listSources',
  captureStart: 'capture:start',
  captureStop: 'capture:stop',
  captureGetState: 'capture:getState',
  captureSetPaused: 'capture:setPaused',
  /** renderer → main: per-frame summary (no pixels). */
  captureFrameSummary: 'capture:frameSummary',
  /** main → renderer: please send a frame for Vision. */
  captureFrameRequest: 'capture:frameRequest',
  /** renderer → main: the requested frame. */
  captureFrameResponse: 'capture:frameResponse',
  /** renderer → main: short OCR summary (≤300 chars) of a high-change frame. Never logged or stored. */
  captureOcrSummary: 'capture:ocrSummary',
  /** main → renderer: OCR settings / resource mode changed (OcrSettingsPush). */
  captureOcrConfig: 'capture:ocrConfig',

  friendSubmitText: 'friend:submitText',
  friendGetState: 'friend:getState',
  friendInterrupt: 'friend:interrupt',
  /** main → renderers: state / transcript / speech pushes. */
  friendEvent: 'friend:event',

  voiceStart: 'voice:start',
  voiceStop: 'voice:stop',
  voiceSetDevice: 'voice:setDevice',
  /** renderer → main: VAD/STT events from the voice service. */
  voiceEvent: 'voice:event',
  /** renderer → main: TTS playback started / finished. */
  voicePlayback: 'voice:playback',
  voiceBackchannel: 'voice:backchannel',
  voiceInterrupt: 'voice:interrupt',
  voiceFloorChanged: 'voice:floorChanged',

  audioListDevices: 'audio:listDevices',
  audioGetState: 'audio:getState',
  audioGetRouting: 'audio:getRouting',
  audioApplyRouting: 'audio:applyRouting',
  audioSnapshotRouting: 'audio:snapshotRouting',
  audioRestoreRouting: 'audio:restoreRouting',

  avatarSetVisible: 'avatar:setVisible',
  avatarSetClickThrough: 'avatar:setClickThrough',
  avatarPerformance: 'avatar:performance',
  avatarLipSync: 'avatar:lipsync',

  pluginList: 'plugin:list',
  pluginActivate: 'plugin:activate',
  pluginGetState: 'plugin:getState',
  /** Plugin-specific UI calls, routed to GamePlugin.handleUiRequest. */
  pluginInvoke: 'plugin:invoke',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  /** Memory tab (§6.5, PR-09). */
  memoryList: 'memory:list',
  memorySearch: 'memory:search',
  memoryUpdate: 'memory:update',
  memoryDelete: 'memory:delete',
  memoryClear: 'memory:clear',
  memoryStats: 'memory:stats',
  /** PR-10 Diagnostics tab: health, processes, latency, errors, resources. */
  diagnosticsGet: 'diagnostics:get',
  /** Restart one supervised helper process by id. */
  diagnosticsRestartProcess: 'diagnostics:restartProcess',
  /** Save a diagnostics JSON through a save dialog. */
  diagnosticsExport: 'diagnostics:export',
} as const;

/** What memory:clear removes: session memories, long-term memories, or everything incl. logs. */
export type MemoryClearScope = 'session' | 'long' | 'all';

export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnailDataUrl: string;
}

export interface NaviSettings {
  userName: string;
  speakerId: number;
  resourceMode: 'GAME_PRIORITY' | 'BALANCED' | 'DESKTOP_CHAT';
  quiet: boolean;
  useAlternateChatModel: boolean;
  avatarVisible: boolean;
  avatarClickThrough: boolean;
  /** Persist conversation memory across sessions. */
  persistMemory: boolean;
  micDeviceId: string | null;
  /** Log every utterance and screen summary to navi.sqlite (opt-in, §6.5). */
  persistUtterances: boolean;
  /** Days to keep utterance / screen logs and unused session memories. */
  utteranceRetentionDays: number;
  /** Pick the resource mode from the situation (game / share / idle); off = resourceMode. */
  autoResourceMode: boolean;
  /** Also append local metrics (numbers only, no text or images) to userData/logs. */
  telemetryToFile: boolean;
  /** Helper processes NAVI starts and supervises. All off by default. */
  managedProcesses: ManagedProcessesSettings;
  /** Read text on the shared screen (OCR, RAM only). */
  ocrEnabled: boolean;
  /** OCR is off in GAME_PRIORITY unless this is on (§4: protect game FPS). */
  ocrInGamePriority: boolean;
  audio: AudioSettings;
}

export interface AudioSettings {
  userMicDeviceId: string | null;
  naviOutputDeviceName: string;
  fallbackOutputDeviceId: string | null;
  systemListenBus: 'B2';
  remoteListenBus: 'B3';
  voicemeeterAutoConfigure: boolean;
  voicemeeterRestoreOnExit: boolean;
  fullDuplex: boolean;
  userBackchannelRecognition: boolean;
  naviBackchannel: boolean;
  naviInterruptions: boolean;
  naviInterruptionLevel: 'LOW' | 'NORMAL' | 'HIGH';
  listenSystemAudio: boolean;
  listenRemoteAudio: boolean;
  remoteConversationContext: boolean;
  remoteReactionLevel: 'OFF' | 'LOW' | 'NORMAL';
  voicemodEnabled: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  userMicDeviceId: null,
  naviOutputDeviceName: 'Voicemeeter VAIO3 Input',
  fallbackOutputDeviceId: null,
  systemListenBus: 'B2',
  remoteListenBus: 'B3',
  voicemeeterAutoConfigure: true,
  voicemeeterRestoreOnExit: true,
  fullDuplex: true,
  userBackchannelRecognition: true,
  naviBackchannel: true,
  naviInterruptions: true,
  naviInterruptionLevel: 'NORMAL',
  listenSystemAudio: true,
  listenRemoteAudio: true,
  remoteConversationContext: true,
  remoteReactionLevel: 'LOW',
  voicemodEnabled: false,
};

export const DEFAULT_SETTINGS: NaviSettings = {
  userName: 'しま',
  speakerId: 8,
  resourceMode: 'BALANCED',
  quiet: false,
  useAlternateChatModel: false,
  avatarVisible: true,
  avatarClickThrough: true,
  persistMemory: false,
  micDeviceId: null,
  persistUtterances: false,
  utteranceRetentionDays: 30,
  autoResourceMode: true,
  telemetryToFile: false,
  managedProcesses: DEFAULT_MANAGED_PROCESSES,
  ocrEnabled: true,
  ocrInGamePriority: false,
  audio: { ...DEFAULT_AUDIO_SETTINGS },
};

export interface AudioDevice {
  id: string;
  name: string;
  kind: 'input' | 'output';
  sourceHint?: AudioSource;
  sampleRate?: number;
}

export interface RoutingSnapshot {
  version: 1;
  capturedAt: string;
  voicemeeterType: 'potato' | 'banana' | 'basic' | 'unknown';
  strips: Record<string, Record<string, number | boolean | string>>;
  buses: Record<string, Record<string, number | boolean | string>>;
  changed?: Array<{ parameter: string; before: number; applied: number }>;
}

export interface AudioRuntimeState {
  voiceService: boolean;
  voicemeeter: boolean;
  voicemeeterType: RoutingSnapshot['voicemeeterType'];
  vaio3Output: 'connected' | 'missing' | 'fallback';
  outputDeviceName: string | null;
  systemListener: boolean;
  remoteListener: boolean;
  floor: FloorState;
  warning?: string;
}

/** What the renderer's OCR scheduler needs from settings. */
export type OcrSettingsPush = Pick<NaviSettings, 'ocrEnabled' | 'ocrInGamePriority' | 'resourceMode'>;

export type FriendPush =
  | { type: 'transcript'; role: 'user' | 'navi'; text: string; at: number; interrupted?: boolean }
  | { type: 'speech'; text: string; audio: ArrayBuffer | null; lipsync: Array<{ t: number; open: number; form: number }>; chunkId?: string; backchannel?: boolean; interrupt?: 'SOFT_INTERRUPT' | 'HARD_INTERRUPT' }
  | { type: 'stopSpeech'; fadeMs?: number }
  | { type: 'health'; services: Record<string, boolean> }
  | { type: 'capture'; sharing: boolean; sourceName: string | null; paused: boolean }
  | { type: 'plugin'; active: string | null };

export type VoiceServiceEvent =
  | { type: 'speech_started'; at: number; source: AudioSource; energy?: number }
  | { type: 'speech_ended'; at: number; source: AudioSource; durationMs?: number }
  | { type: 'partial'; text: string; at: number; source: AudioSource; durationMs: number; energy: number; echoCorrelation?: number }
  | { type: 'transcript'; text: string; at: number; source: AudioSource; durationMs?: number; energy?: number; echoCorrelation?: number }
  | { type: 'system_event'; event: string; confidence: number; at: number; source: 'SYSTEM' };

export interface VoicePlaybackEvent {
  state: 'started' | 'finished';
  backchannel: boolean;
  mode?: 'normal' | 'backchannel' | 'interrupt';
}
