import { app, BrowserWindow, desktopCapturer, ipcMain, session, screen } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { EventBus } from '../src/core/events/EventBus';
import { OllamaClient } from '../src/core/ai/OllamaClient';
import { ModelRouter } from '../src/core/ai/ModelRouter';
import { HealthMonitor } from '../src/core/ai/HealthMonitor';
import { ResourceGovernor } from '../src/core/resource/ResourceGovernor';
import { InMemoryMemoryStore } from '../src/core/memory/MemoryStore';
import { PluginHost } from '../src/core/plugins/PluginHost';
import { FriendOrchestrator } from '../src/core/orchestrator/FriendOrchestrator';
import { VisionService, type FrameProvider, type VisionFrame } from '../src/core/screen/VisionService';
import type { FrameSummary } from '../src/core/screen/FrameSummary';
import { classifyChange } from '../src/core/screen/FrameDiff';
import { VoicevoxClient, voiceStyleFor } from '../src/core/voice/VoicevoxClient';
import { BargeInController } from '../src/core/voice/BargeIn';
import { buildLipSyncTimeline } from '../src/core/voice/LipSync';
import { TarkovPlugin } from '../src/plugins/tarkov/TarkovPlugin';
import {
  DEFAULT_SETTINGS,
  IPC,
  type CaptureSource,
  type FriendPush,
  type NaviSettings,
  type VoiceServiceEvent,
} from './ipc';

const DEV_URL = process.argv.includes('--dev') ? 'http://localhost:5173' : process.env.VITE_DEV_SERVER_URL;
const VOICE_SERVICE_URL = 'http://127.0.0.1:17650';
const INITIATIVE_TICK_MS = 5_000;
const FRAME_REQUEST_TIMEOUT_MS = 1_500;

let mainWindow: BrowserWindow | null = null;
let avatarWindow: BrowserWindow | null = null;
let settings: NaviSettings = { ...DEFAULT_SETTINGS };

const capture = {
  sourceId: null as string | null,
  sourceName: null as string | null,
  kind: 'window' as 'screen' | 'window',
  paused: false,
};

// ───────────── settings ─────────────

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

async function loadSettings(): Promise<void> {
  try {
    settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as Partial<NaviSettings>) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2));
}

// ───────────── core wiring ─────────────

const bus = new EventBus();
const governor = new ResourceGovernor(DEFAULT_SETTINGS.resourceMode);
const router = new ModelRouter(governor);
const ollama = new OllamaClient();
const memory = new InMemoryMemoryStore();
const plugins = new PluginHost(bus);
plugins.register(new TarkovPlugin());
let tts = new VoicevoxClient(DEFAULT_SETTINGS.speakerId);

const pendingFrames = new Map<string, (frame: VisionFrame | null) => void>();

/** Vision frames live in the renderer's RAM ring buffer; ask for one on demand. */
const frameProvider: FrameProvider = {
  getFrame(which) {
    if (!mainWindow || !capture.sourceId || capture.paused) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingFrames.delete(requestId);
        resolve(null);
      }, FRAME_REQUEST_TIMEOUT_MS);
      pendingFrames.set(requestId, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      mainWindow!.webContents.send(IPC.captureFrameRequest, { requestId, which });
    });
  },
};

const health = new HealthMonitor(bus, {
  chat: () => ollama.ping(),
  // Vision runs on the same Ollama instance.
  vision: () => ollama.ping(),
  tts: () => tts.ping(),
  stt: async () => {
    try {
      return (await fetch(`${VOICE_SERVICE_URL}/health`)).ok;
    } catch {
      return false;
    }
  },
});

const orchestrator = new FriendOrchestrator({
  bus,
  ollama,
  router,
  memory,
  plugins,
  vision: new VisionService(ollama, router, governor, frameProvider),
  persona: { get userName() { return settings.userName; } },
  isHealthy: (s) => health.isHealthy(s),
  reportFailure: (s) => health.reportFailure(s),
  quiet: () => settings.quiet,
  sharing: () => capture.sourceId !== null && !capture.paused,
});

const bargeIn = new BargeInController({
  fadeOut: () => push({ type: 'stopSpeech' }),
  stopMouth: () => sendAvatar(IPC.avatarLipSync, null),
  markInterrupted: () => bus.emit('voice.interrupted', { at: Date.now() }),
});

function push(p: FriendPush): void {
  mainWindow?.webContents.send(IPC.friendEvent, p);
}

function sendAvatar(channel: string, payload: unknown): void {
  // Avatar failures must never affect the conversation (§19).
  try {
    if (avatarWindow && !avatarWindow.isDestroyed()) avatarWindow.webContents.send(channel, payload);
  } catch (err) {
    console.error('[avatar] send failed', err);
  }
}

bus.on('health.changed', () => push({ type: 'health', services: health.snapshot() as Record<string, boolean> }));
bus.on('avatar.performance', (cue) => sendAvatar(IPC.avatarPerformance, cue));
bus.on('voice.transcript', (u) => push({ type: 'transcript', role: 'user', text: u.text, at: u.at }));
bus.on('memory.write', (m) => {
  if (settings.persistMemory) memory.write(m.text, 'long', Date.now());
});

bus.on('friend.speak', ({ text, cue }) => {
  push({ type: 'transcript', role: 'navi', text, at: Date.now() });
  void speak(text, cue.emotion, cue.intensity);
});

async function speak(text: string, emotion: string, intensity: number): Promise<void> {
  if (!bargeIn.canSpeak()) return;
  if (!health.isHealthy('tts')) {
    // Subtitles only; no mouth movement without audio (§19).
    push({ type: 'speech', text, audio: null, lipsync: [] });
    return;
  }
  try {
    const temperature = orchestrator.conversation.suggestTemperature(text);
    const { audio, query } = await tts.synthesize(text, voiceStyleFor(emotion, intensity, temperature));
    if (!bargeIn.canSpeak()) return;
    const lipsync = query ? buildLipSyncTimeline(query) : [];
    push({ type: 'speech', text, audio, lipsync });
  } catch (err) {
    console.error('[tts] failed', err);
    health.reportFailure('tts');
    push({ type: 'speech', text, audio: null, lipsync: [] });
  }
}

// ───────────── windows ─────────────

function loadPage(win: BrowserWindow, page: 'index' | 'avatar'): void {
  if (DEV_URL) void win.loadURL(`${DEV_URL}/${page}.html`);
  else void win.loadFile(path.join(__dirname, '../../dist', `${page}.html`));
}

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
});

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: 'NAVI',
    backgroundColor: '#121318',
    webPreferences: webPreferences(),
  });
  loadPage(mainWindow, 'index');
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

function createAvatarWindow(): void {
  const { workArea } = screen.getPrimaryDisplay();
  avatarWindow = new BrowserWindow({
    width: 360,
    height: 480,
    x: workArea.x + workArea.width - 380,
    y: workArea.y + workArea.height - 500,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: settings.avatarVisible,
    webPreferences: webPreferences(),
  });
  avatarWindow.setAlwaysOnTop(true, 'screen-saver');
  avatarWindow.setIgnoreMouseEvents(settings.avatarClickThrough, { forward: true });
  loadPage(avatarWindow, 'avatar');
  avatarWindow.webContents.on('render-process-gone', () => {
    console.error('[avatar] renderer crashed; conversation continues');
  });
  avatarWindow.on('closed', () => {
    avatarWindow = null;
  });
}

// ───────────── IPC ─────────────

function registerIpc(): void {
  ipcMain.handle(IPC.captureListSources, async (): Promise<CaptureSource[]> => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources
      .filter((s) => !s.name.startsWith('NAVI'))
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnailDataUrl: s.thumbnail.toDataURL(),
      }));
  });

  ipcMain.handle(IPC.captureStart, async (_e, sourceId: string, sourceName: string, kind: 'screen' | 'window') => {
    capture.sourceId = sourceId;
    capture.sourceName = sourceName;
    capture.kind = kind;
    capture.paused = false;
    const plugin = await plugins.onWindowShared({ sourceId, title: sourceName, kind });
    push({ type: 'plugin', active: plugin?.id ?? null });
    push({ type: 'capture', sharing: true, sourceName, paused: false });
  });

  ipcMain.handle(IPC.captureStop, () => {
    capture.sourceId = null;
    capture.sourceName = null;
    push({ type: 'capture', sharing: false, sourceName: null, paused: false });
  });

  ipcMain.handle(IPC.captureGetState, () => ({
    sharing: capture.sourceId !== null,
    sourceName: capture.sourceName,
    paused: capture.paused,
  }));

  ipcMain.on(IPC.captureFrameSummary, (_e, summary: FrameSummary) => {
    if (!capture.sourceId || summary.sourceId !== capture.sourceId) return;
    bus.emit('screen.frame', summary);
    if (classifyChange(summary.change) !== 'none') bus.emit('screen.changed', summary);
    void plugins.onFrame(summary);
  });

  ipcMain.on(IPC.captureFrameResponse, (_e, requestId: string, frame: VisionFrame | null) => {
    const resolve = pendingFrames.get(requestId);
    if (!resolve) return;
    pendingFrames.delete(requestId);
    // Never treat a frame from a previous source as the current screen.
    resolve(frame && frame.sourceId === capture.sourceId ? { ...frame, sourceName: capture.sourceName ?? '' } : null);
  });

  ipcMain.handle(IPC.friendSubmitText, (_e, text: string) => {
    const trimmed = String(text).trim();
    if (!trimmed) return;
    bus.emit('voice.transcript', { id: randomUUID(), text: trimmed, source: 'text', at: Date.now() });
  });

  ipcMain.handle(IPC.friendGetState, () => ({
    health: health.snapshot(),
    conversation: orchestrator.conversation.snapshot(),
    plugin: plugins.activePlugin?.id ?? null,
    resourceMode: governor.currentMode,
  }));

  ipcMain.handle(IPC.friendInterrupt, () => {
    orchestrator.interrupt();
    push({ type: 'stopSpeech' });
    sendAvatar(IPC.avatarLipSync, null);
  });

  ipcMain.handle(IPC.voiceStart, () => undefined);
  ipcMain.handle(IPC.voiceStop, () => undefined);
  ipcMain.handle(IPC.voiceSetDevice, async (_e, deviceId: string | null) => {
    settings.micDeviceId = deviceId;
    await saveSettings();
  });

  ipcMain.on(IPC.voiceEvent, (_e, ev: VoiceServiceEvent) => {
    if (ev.type === 'speech_started') {
      bargeIn.userSpeechStarted();
      bus.emit('voice.speech_started', { at: ev.at });
    } else if (ev.type === 'speech_ended') {
      bargeIn.userSpeechEnded();
    } else if (ev.type === 'transcript' && ev.text.trim()) {
      bargeIn.userSpeechEnded();
      bus.emit('voice.transcript', { id: randomUUID(), text: ev.text.trim(), source: 'voice', at: ev.at });
    }
  });

  ipcMain.on(IPC.voicePlayback, (_e, state: 'started' | 'finished') => {
    if (state === 'started') {
      bargeIn.naviStarted();
      orchestrator.conversation.setSpeaking(true);
    } else {
      bargeIn.naviFinished();
      orchestrator.conversation.setSpeaking(false);
    }
  });

  // The main window plays the audio, then forwards the lip-sync timeline here at playback start.
  ipcMain.on(IPC.avatarLipSync, (_e, frames: unknown) => sendAvatar(IPC.avatarLipSync, frames));

  ipcMain.handle(IPC.avatarSetVisible, async (_e, visible: boolean) => {
    settings.avatarVisible = visible;
    if (visible) {
      if (!avatarWindow) createAvatarWindow();
      avatarWindow?.showInactive();
    } else {
      avatarWindow?.hide();
    }
    await saveSettings();
  });

  ipcMain.handle(IPC.avatarSetClickThrough, async (_e, on: boolean) => {
    settings.avatarClickThrough = on;
    avatarWindow?.setIgnoreMouseEvents(on, { forward: true });
    await saveSettings();
  });

  ipcMain.handle(IPC.pluginList, () => plugins.list());
  ipcMain.handle(IPC.pluginActivate, async (_e, id: string | null) => {
    await plugins.activate(id);
    push({ type: 'plugin', active: plugins.activePlugin?.id ?? null });
  });
  ipcMain.handle(IPC.pluginGetState, () => ({ active: plugins.activePlugin?.id ?? null }));

  ipcMain.handle(IPC.settingsGet, () => settings);
  ipcMain.handle(IPC.settingsSet, async (_e, patch: Partial<NaviSettings>) => {
    settings = { ...settings, ...patch };
    applySettings();
    await saveSettings();
    return settings;
  });
}

function applySettings(): void {
  governor.setMode(settings.resourceMode);
  router.setUseAlternateChat(settings.useAlternateChatModel);
  tts = new VoicevoxClient(settings.speakerId);
}

// ───────────── lifecycle ─────────────

app.whenReady().then(async () => {
  await loadSettings();
  applySettings();
  registerIpc();

  // getDisplayMedia in the renderer receives exactly the source the user picked (§7.1).
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const chosen = sources.find((s) => s.id === capture.sourceId);
    if (chosen) callback({ video: chosen });
    else callback({});
  });

  createMainWindow();
  if (settings.avatarVisible) createAvatarWindow();

  health.start();
  bus.emit('session.started', { at: Date.now() });

  setInterval(() => {
    void orchestrator.considerInitiative().catch((err) => console.error('[initiative]', err));
  }, INITIATIVE_TICK_MS);
});

app.on('before-quit', () => {
  health.stop();
  bus.emit('session.ended', { at: Date.now() });
  if (!settings.persistMemory) memory.clearSession();
});
