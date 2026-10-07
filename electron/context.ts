import { EventBus } from '../src/core/events/EventBus';
import { OllamaClient } from '../src/core/ai/OllamaClient';
import { ModelRouter } from '../src/core/ai/ModelRouter';
import { HealthMonitor } from '../src/core/ai/HealthMonitor';
import { ResourceGovernor } from '../src/core/resource/ResourceGovernor';
import type { MemoryStore } from '../src/core/memory/MemoryStore';
import { createMemoryStore } from './features/memory';
import { PluginHost } from '../src/core/plugins/PluginHost';
import { FriendOrchestrator } from '../src/core/orchestrator/FriendOrchestrator';
import { VisionService } from '../src/core/screen/VisionService';
import { VoicevoxClient } from '../src/core/voice/VoicevoxClient';
import type { TtsAdapter } from '../src/core/voice/TtsAdapter';
import { TarkovPlugin } from '../src/plugins/tarkov/TarkovPlugin';
import { FrameBridge, type CaptureState } from './frameBridge';
import type { SettingsStore } from './settings';
import type { WindowManager } from './windows';
import { TaskSnapshotPublisher, formatTaskSnapshots, type TaskSnapshot } from '../src/core/tasks/TaskSnapshotPublisher';

export const VOICE_SERVICE_URL = 'http://127.0.0.1:17650';

/** Everything a Feature may use. Built once at startup. */
export interface AppContext {
  bus: EventBus;
  settings: SettingsStore;
  windows: WindowManager;
  governor: ResourceGovernor;
  router: ModelRouter;
  ollama: OllamaClient;
  memory: MemoryStore;
  plugins: PluginHost;
  health: HealthMonitor;
  orchestrator: FriendOrchestrator;
  capture: CaptureState;
  frames: FrameBridge;
  /** Mutable so the voice feature can swap the TTS engine when settings change. */
  voice: { tts: TtsAdapter };
  tasks: TaskSnapshotPublisher;
  tasksOnPublish?: (snapshot: TaskSnapshot) => void;
}

export function createContext(settings: SettingsStore, windows: WindowManager): AppContext {
  const bus = new EventBus();
  const s = settings.current;
  const governor = new ResourceGovernor(s.resourceMode);
  const router = new ModelRouter(governor);
  const ollama = new OllamaClient();
  // SQLite (userData/navi.sqlite) with an in-memory fallback; see features/memory.ts.
  const memory: MemoryStore = createMemoryStore(settings);
  const plugins = new PluginHost(bus);
  plugins.register(new TarkovPlugin());

  const capture: CaptureState = { sourceId: null, sourceName: null, kind: 'window', paused: false };
  const frames = new FrameBridge(windows, capture);
  const voice = { tts: new VoicevoxClient(s.speakerId) as TtsAdapter };
  // Snapshot publication is bounded. Reading task state never waits on a worker.
  let ctx: AppContext;
  const tasks = new TaskSnapshotPublisher((snapshot) => ctx?.tasksOnPublish?.(snapshot));

  const health = new HealthMonitor(bus, {
    chat: () => ollama.ping(),
    // Vision runs on the same Ollama instance.
    vision: () => ollama.ping(),
    tts: () => voice.tts.health(),
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
    vision: new VisionService(ollama, router, governor, frames),
    persona: {
      get userName() {
        return settings.current.userName;
      },
    },
    isHealthy: (svc) => health.isHealthy(svc),
    reportFailure: (svc) => health.reportFailure(svc),
    quiet: () => settings.current.quiet,
    sharing: () => capture.sourceId !== null && !capture.paused,
    recentSystemAudio: async () => {
      const response = await fetch(`${VOICE_SERVICE_URL}/audio/classify/recent?seconds=6`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return null;
      const result = (await response.json()) as { event?: { type: string; confidence: number; at: number } | null };
      return result.event ?? null;
    },
    desktopText: {
      visible: () => windows.textState.visible,
      command: (command) => windows.textCommand(command),
      taskStatus: () => formatTaskSnapshots(tasks.list()),
    },
  });

  ctx = { bus, settings, windows, governor, router, ollama, memory, plugins, health, orchestrator, capture, frames, voice, tasks };
  return ctx;
}
