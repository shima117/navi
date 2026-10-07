import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CaptureSource, FriendPush, NaviSettings, VoiceServiceEvent } from './ipc';

// Sandboxed preloads cannot require local modules, so channel names are
// literals here; they must match electron/ipc.ts.

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** The only API the renderer gets (design doc §17): no Node access, no keys. */
const api = {
  capture: {
    listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('capture:listSources'),
    start: (sourceId: string, sourceName: string, kind: 'screen' | 'window'): Promise<void> =>
      ipcRenderer.invoke('capture:start', sourceId, sourceName, kind),
    stop: (): Promise<void> => ipcRenderer.invoke('capture:stop'),
    getState: (): Promise<{ sharing: boolean; sourceName: string | null; paused: boolean }> =>
      ipcRenderer.invoke('capture:getState'),
    sendFrameSummary: (summary: unknown) => ipcRenderer.send('capture:frameSummary', summary),
    onFrameRequest: (cb: (req: { requestId: string; which: 'latest' | 'recent' }) => void) =>
      subscribe('capture:frameRequest', cb),
    respondFrame: (requestId: string, frame: unknown) => ipcRenderer.send('capture:frameResponse', requestId, frame),
  },
  friend: {
    submitText: (text: string): Promise<void> => ipcRenderer.invoke('friend:submitText', text),
    getState: (): Promise<unknown> => ipcRenderer.invoke('friend:getState'),
    interrupt: (): Promise<void> => ipcRenderer.invoke('friend:interrupt'),
    onEvent: (cb: (push: FriendPush) => void) => subscribe('friend:event', cb),
  },
  voice: {
    start: (): Promise<void> => ipcRenderer.invoke('voice:start'),
    stop: (): Promise<void> => ipcRenderer.invoke('voice:stop'),
    setDevice: (deviceId: string | null): Promise<void> => ipcRenderer.invoke('voice:setDevice', deviceId),
    sendEvent: (event: VoiceServiceEvent) => ipcRenderer.send('voice:event', event),
    playback: (state: 'started' | 'finished') => ipcRenderer.send('voice:playback', state),
  },
  avatar: {
    setVisible: (visible: boolean): Promise<void> => ipcRenderer.invoke('avatar:setVisible', visible),
    setClickThrough: (on: boolean): Promise<void> => ipcRenderer.invoke('avatar:setClickThrough', on),
    onPerformance: (cb: (cue: unknown) => void) => subscribe('avatar:performance', cb),
    /** Main window → avatar window, at the moment audio playback starts. */
    forwardLipSync: (frames: Array<{ t: number; open: number; form: number }> | null) =>
      ipcRenderer.send('avatar:lipsync', frames),
    onLipSync: (cb: (frames: Array<{ t: number; open: number; form: number }> | null) => void) =>
      subscribe('avatar:lipsync', cb),
  },
  plugin: {
    list: (): Promise<Array<{ id: string; displayName: string; active: boolean }>> => ipcRenderer.invoke('plugin:list'),
    activate: (id: string | null): Promise<void> => ipcRenderer.invoke('plugin:activate', id),
    getState: (): Promise<{ active: string | null }> => ipcRenderer.invoke('plugin:getState'),
  },
  settings: {
    get: (): Promise<NaviSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<NaviSettings>): Promise<NaviSettings> => ipcRenderer.invoke('settings:set', patch),
  },
};

export type NaviApi = typeof api;

contextBridge.exposeInMainWorld('navi', api);
