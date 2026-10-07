import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CaptureSource, FriendPush, NaviSettings } from '../../../electron/ipc';
import { PROFILES } from '../../core/resource/ResourceGovernor';
import { ScreenStreamManager } from '../ScreenStreamManager';
import { SpeechPlayer, type OutputSelection } from '../SpeechPlayer';
import { VoiceClient } from '../VoiceClient';

export interface TranscriptLine {
  role: 'user' | 'navi';
  text: string;
  at: number;
}

export interface NaviState {
  lines: TranscriptLine[];
  health: Record<string, boolean>;
  sharing: { on: boolean; name: string | null };
  paused: boolean;
  micOn: boolean;
  voiceConnected: boolean;
  audioOutput: OutputSelection;
  plugin: string | null;
  settings: NaviSettings | null;
  /** Live share stream for previews (null when not sharing). */
  stream: MediaStream | null;
  screen: ScreenStreamManager;
  updateSettings(patch: Partial<NaviSettings>): Promise<void>;
  /** Re-read settings changed by main (e.g. avatar toggles). */
  refreshSettings(): Promise<void>;
  submitText(text: string): Promise<void>;
  startShare(src: CaptureSource): Promise<void>;
  stopShare(): Promise<void>;
  togglePause(): void;
  toggleMic(): Promise<void>;
}

const Ctx = createContext<NaviState | null>(null);

export function useNavi(): NaviState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNavi outside NaviProvider');
  return v;
}

/** Shared renderer state and the long-lived media services. */
export function NaviProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [health, setHealth] = useState<Record<string, boolean>>({});
  const [sharing, setSharing] = useState<{ on: boolean; name: string | null }>({ on: false, name: null });
  const [paused, setPaused] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [voiceConnected, setVoiceConnected] = useState(false);
  const [audioOutput, setAudioOutput] = useState<OutputSelection>({ status: 'missing', deviceId: null, label: null });
  const [plugin, setPlugin] = useState<string | null>(null);
  const [settings, setSettings] = useState<NaviSettings | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const screenRef = useRef<ScreenStreamManager>(null);
  const playerRef = useRef<SpeechPlayer>(null);
  const voiceRef = useRef<VoiceClient>(null);
  screenRef.current ??= new ScreenStreamManager();
  playerRef.current ??= new SpeechPlayer();
  voiceRef.current ??= new VoiceClient(setVoiceConnected);

  useEffect(() => {
    void window.navi.settings.get().then(setSettings);
    // Health/plugin changes may have been pushed before this window subscribed.
    void window.navi.friend.getState().then((s) => {
      const state = s as { health: Record<string, boolean>; plugin: string | null };
      setHealth(state.health);
      setPlugin(state.plugin);
    });
    return window.navi.friend.onEvent((p: FriendPush) => {
      switch (p.type) {
        case 'transcript':
          setLines((ls) => [...ls.slice(-200), { role: p.role, text: p.text, at: p.at }]);
          break;
        case 'speech':
          if (p.audio) void playerRef.current!.enqueue(p.audio, p.lipsync, p.backchannel ?? false, Boolean(p.interrupt)).catch((e) => console.error('[speech]', e));
          break;
        case 'stopSpeech':
          playerRef.current!.stop(p.fadeMs);
          break;
        case 'health':
          setHealth(p.services);
          break;
        case 'capture':
          setSharing({ on: p.sharing, name: p.sourceName });
          setPaused(p.paused);
          if (!p.sharing) setStream(null);
          break;
        case 'plugin':
          setPlugin(p.active);
          break;
      }
    });
  }, []);

  useEffect(() => {
    if (!settings) return;
    void playerRef.current!
      .configureOutput(settings.audio.naviOutputDeviceName, settings.audio.fallbackOutputDeviceId)
      .then(setAudioOutput)
      .catch((err) => {
        console.error('[speech] output discovery failed', err);
        setAudioOutput({ status: 'missing', deviceId: null, label: null });
      });
  }, [settings?.audio.naviOutputDeviceName, settings?.audio.fallbackOutputDeviceId]);

  const updateSettings = useCallback(async (patch: Partial<NaviSettings>) => {
    setSettings(await window.navi.settings.set(patch));
  }, []);

  const refreshSettings = useCallback(async () => {
    setSettings(await window.navi.settings.get());
  }, []);

  const submitText = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    playerRef.current!.stop();
    await window.navi.friend.submitText(t);
  }, []);

  const startShare = useCallback(
    async (src: CaptureSource) => {
      const fps = PROFILES[settings?.resourceMode ?? 'BALANCED'].sampleFps;
      setStream(await screenRef.current!.start(src.id, src.name, src.kind, fps));
      setPaused(false);
    },
    [settings],
  );

  const stopShare = useCallback(async () => {
    await screenRef.current!.stop();
    setStream(null);
  }, []);

  const togglePause = useCallback(() => {
    const next = !paused;
    screenRef.current!.setPaused(next);
    setPaused(next);
    void window.navi.capture.setPaused(next);
  }, [paused]);

  const toggleMic = useCallback(async () => {
    if (micOn) {
      await voiceRef.current!.stop();
      setMicOn(false);
      return;
    }
    try {
      await voiceRef.current!.start(settings?.audio.userMicDeviceId ?? settings?.micDeviceId ?? null);
      setMicOn(true);
    } catch (e) {
      console.error('[mic]', e);
    }
  }, [micOn, settings]);

  const value = useMemo<NaviState>(
    () => ({
      lines,
      health,
      sharing,
      paused,
      micOn,
      voiceConnected,
      audioOutput,
      plugin,
      settings,
      stream,
      screen: screenRef.current!,
      updateSettings,
      refreshSettings,
      submitText,
      startShare,
      stopShare,
      togglePause,
      toggleMic,
    }),
    [lines, health, sharing, paused, micOn, voiceConnected, audioOutput, plugin, settings, stream, updateSettings, refreshSettings, submitText, startShare, stopShare, togglePause, toggleMic],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
