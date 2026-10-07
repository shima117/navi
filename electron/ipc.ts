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
} as const;

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
}

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
};

export type FriendPush =
  | { type: 'transcript'; role: 'user' | 'navi'; text: string; at: number; interrupted?: boolean }
  | { type: 'speech'; text: string; audio: ArrayBuffer | null; lipsync: Array<{ t: number; open: number; form: number }> }
  | { type: 'stopSpeech' }
  | { type: 'health'; services: Record<string, boolean> }
  | { type: 'capture'; sharing: boolean; sourceName: string | null; paused: boolean }
  | { type: 'plugin'; active: string | null };

export type VoiceServiceEvent =
  | { type: 'speech_started'; at: number }
  | { type: 'speech_ended'; at: number }
  | { type: 'transcript'; text: string; at: number };
