import type { DiagnosticsExportResult, DiagnosticsSnapshot } from '../src/core/telemetry/DiagnosticsReport';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type CaptureSource,
  type AudioDevice,
  type AudioRuntimeState,
  type FriendPush,
  type NaviSettings,
  type OcrSettingsPush,
  type RoutingSnapshot,
  type VoiceServiceEvent,
  type VoicePlaybackEvent,
} from './ipc';
import type { MemoryClearScope } from './ipc';
import type { MemoryItem, MemoryStats, MemoryTier } from '../src/core/memory/MemoryStore';

// Bundled with esbuild (sandboxed preloads cannot require local modules).

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

type LipSyncFrames = Array<{ t: number; open: number; form: number }>;

/** The only API the renderer gets (design doc §17): no Node access, no keys. */
const api = {
  capture: {
    listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC.captureListSources),
    start: (sourceId: string, sourceName: string, kind: 'screen' | 'window'): Promise<void> =>
      ipcRenderer.invoke(IPC.captureStart, sourceId, sourceName, kind),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.captureStop),
    setPaused: (paused: boolean): Promise<void> => ipcRenderer.invoke(IPC.captureSetPaused, paused),
    getState: (): Promise<{ sharing: boolean; sourceName: string | null; paused: boolean }> =>
      ipcRenderer.invoke(IPC.captureGetState),
    sendFrameSummary: (summary: unknown) => ipcRenderer.send(IPC.captureFrameSummary, summary),
    onFrameRequest: (cb: (req: { requestId: string; which: 'latest' | 'recent' }) => void) =>
      subscribe(IPC.captureFrameRequest, cb),
    respondFrame: (requestId: string, frame: unknown) => ipcRenderer.send(IPC.captureFrameResponse, requestId, frame),
    sendOcrSummary: (summary: unknown) => ipcRenderer.send(IPC.captureOcrSummary, summary),
    onOcrConfig: (cb: (cfg: OcrSettingsPush) => void) => subscribe(IPC.captureOcrConfig, cb),
  },
  friend: {
    submitText: (text: string): Promise<void> => ipcRenderer.invoke(IPC.friendSubmitText, text),
    getState: (): Promise<unknown> => ipcRenderer.invoke(IPC.friendGetState),
    interrupt: (): Promise<void> => ipcRenderer.invoke(IPC.friendInterrupt),
    onEvent: (cb: (push: FriendPush) => void) => subscribe(IPC.friendEvent, cb),
  },
  voice: {
    start: (): Promise<void> => ipcRenderer.invoke(IPC.voiceStart),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.voiceStop),
    setDevice: (deviceId: string | null): Promise<void> => ipcRenderer.invoke(IPC.voiceSetDevice, deviceId),
    sendEvent: (event: VoiceServiceEvent) => ipcRenderer.send(IPC.voiceEvent, event),
    playback: (event: VoicePlaybackEvent) => ipcRenderer.send(IPC.voicePlayback, event),
  },
  audio: {
    listDevices: (): Promise<AudioDevice[]> => ipcRenderer.invoke(IPC.audioListDevices),
    getState: (): Promise<AudioRuntimeState> => ipcRenderer.invoke(IPC.audioGetState),
    getRouting: (): Promise<RoutingSnapshot> => ipcRenderer.invoke(IPC.audioGetRouting),
    snapshotRouting: (): Promise<RoutingSnapshot> => ipcRenderer.invoke(IPC.audioSnapshotRouting),
    applyRouting: (): Promise<RoutingSnapshot> => ipcRenderer.invoke(IPC.audioApplyRouting),
    restoreRouting: (): Promise<{ restored: number; skipped: number }> => ipcRenderer.invoke(IPC.audioRestoreRouting),
  },
  avatar: {
    setVisible: (visible: boolean): Promise<void> => ipcRenderer.invoke(IPC.avatarSetVisible, visible),
    setClickThrough: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.avatarSetClickThrough, on),
    onPerformance: (cb: (cue: unknown) => void) => subscribe(IPC.avatarPerformance, cb),
    /** Main window → avatar window, at the moment audio playback starts. */
    forwardLipSync: (frames: LipSyncFrames | null) => ipcRenderer.send(IPC.avatarLipSync, frames),
    onLipSync: (cb: (frames: LipSyncFrames | null) => void) => subscribe(IPC.avatarLipSync, cb),
  },
  plugin: {
    list: (): Promise<Array<{ id: string; displayName: string; active: boolean }>> => ipcRenderer.invoke(IPC.pluginList),
    activate: (id: string | null): Promise<void> => ipcRenderer.invoke(IPC.pluginActivate, id),
    getState: (): Promise<{ active: string | null }> => ipcRenderer.invoke(IPC.pluginGetState),
    /** Plugin-specific UI request (see GamePlugin.handleUiRequest). */
    invoke: <T = unknown>(pluginId: string, method: string, args?: unknown): Promise<T> =>
      ipcRenderer.invoke(IPC.pluginInvoke, pluginId, method, args),
  },
  settings: {
    get: (): Promise<NaviSettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<NaviSettings>): Promise<NaviSettings> => ipcRenderer.invoke(IPC.settingsSet, patch),
  },
  memory: {
    list: (tier?: MemoryTier): Promise<MemoryItem[]> => ipcRenderer.invoke(IPC.memoryList, tier),
    search: (query: string, tier?: MemoryTier): Promise<MemoryItem[]> => ipcRenderer.invoke(IPC.memorySearch, query, tier),
    update: (id: string, text: string): Promise<MemoryItem | null> => ipcRenderer.invoke(IPC.memoryUpdate, id, text),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.memoryDelete, id),
    clear: (scope: MemoryClearScope): Promise<void> => ipcRenderer.invoke(IPC.memoryClear, scope),
    stats: (): Promise<MemoryStats> => ipcRenderer.invoke(IPC.memoryStats),
  },
  diagnostics: {
    get: (): Promise<DiagnosticsSnapshot> => ipcRenderer.invoke(IPC.diagnosticsGet),
    /** Restart a supervised helper process; false if it is not configured. */
    restartProcess: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.diagnosticsRestartProcess, id),
    /** Opens a save dialog in main and writes the snapshot there. */
    export: (): Promise<DiagnosticsExportResult> => ipcRenderer.invoke(IPC.diagnosticsExport),
  },
};

export type NaviApi = typeof api;

contextBridge.exposeInMainWorld('navi', api);
