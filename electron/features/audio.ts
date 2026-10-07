import { ipcMain } from 'electron';
import { IPC, type AudioDevice, type AudioRuntimeState, type RoutingSnapshot } from '../ipc';
import { VOICE_SERVICE_URL } from '../context';
import type { Feature } from './Feature';

let running = false;
let floor: AudioRuntimeState['floor'] = 'SILENCE';
let output: { status: AudioRuntimeState['vaio3Output']; label: string | null } = { status: 'missing', label: null };
let startupWarning: string | null = null;

async function request<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${VOICE_SERVICE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`voice-service ${path}: ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  return (await response.json()) as T;
}

async function state(ctx: Parameters<NonNullable<Feature['start']>>[0]): Promise<AudioRuntimeState> {
  try {
    const service = await request<{
      voiceService: boolean;
      voicemeeter: boolean;
      voicemeeterType: AudioRuntimeState['voicemeeterType'];
      systemListener: boolean;
      remoteListener: boolean;
      crashRecovery?: { pending?: boolean };
    }>('/audio/state');
    return {
      ...service,
      vaio3Output: output.status,
      outputDeviceName: output.label,
      floor,
      warning: startupWarning ?? (service.crashRecovery?.pending ? '前回のNAVI用Voicemeeter設定が残っています' : undefined),
    };
  } catch (err) {
    return {
      voiceService: false,
      voicemeeter: false,
      voicemeeterType: 'unknown',
      vaio3Output: output.status,
      outputDeviceName: output.label,
      systemListener: false,
      remoteListener: false,
      floor,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}

async function startListeners(ctx: Parameters<NonNullable<Feature['start']>>[0]): Promise<void> {
  const audio = ctx.settings.current.audio;
  await request('/audio/start', 'POST', {
    listenSystem: audio.listenSystemAudio,
    listenRemote: audio.listenRemoteAudio,
    systemDeviceId: audio.systemInputDeviceId,
    remoteDeviceId: audio.remoteInputDeviceId,
  });
}

/** Voicemeeter routing and multi-source capture lifecycle (PR-11A). */
export const audioFeature: Feature = {
  name: 'audio',
  setup(ctx) {
    floor = 'SILENCE';
    output = { status: 'missing', label: null };
    startupWarning = null;
    ctx.bus.on('voice.floor_changed', (event) => {
      floor = event.state;
    });
    ipcMain.on(IPC.audioReportOutput, (_event, report: { status?: string; label?: string | null }) => {
      if (report && (report.status === 'connected' || report.status === 'fallback' || report.status === 'missing')) {
        output = { status: report.status, label: typeof report.label === 'string' ? report.label : null };
      }
    });
    ipcMain.handle(IPC.audioListDevices, async (): Promise<AudioDevice[]> => {
      const result = await request<{ devices: Array<{ id: string; name: string; kind: 'input' | 'output'; sample_rate?: number }> }>('/audio/devices');
      return result.devices.map((d) => ({ id: d.id, name: d.name, kind: d.kind, sampleRate: d.sample_rate }));
    });
    ipcMain.handle(IPC.audioGetState, () => state(ctx));
    ipcMain.handle(IPC.audioGetRouting, () => request<RoutingSnapshot>('/voicemeeter/routing'));
    ipcMain.handle(IPC.audioSnapshotRouting, () => request<RoutingSnapshot>('/voicemeeter/snapshot', 'POST'));
    ipcMain.handle(IPC.audioApplyRouting, async () => {
      const result = await request<RoutingSnapshot>('/voicemeeter/auto-configure', 'POST');
      startupWarning = null;
      return result;
    });
    ipcMain.handle(IPC.audioRestoreRouting, async () => {
      const result = await request<{ restored: number; skipped: number }>('/voicemeeter/restore', 'POST');
      startupWarning = null;
      return result;
    });

    settingsListener(ctx);
  },
  async start(ctx) {
    running = true;
    if (ctx.settings.current.managedProcesses.voiceService.enabled) await waitForVoiceService(8_000);
    try {
      const initial = await request<{ crashRecovery?: { pending?: boolean } }>('/audio/state');
      const pendingRecovery = Boolean(initial.crashRecovery?.pending);
      let skipAutoConfigure = false;
      if (pendingRecovery && ctx.settings.current.audio.voicemeeterRestoreOnExit) {
        const restored = await request<{ restored: number; skipped: number }>('/voicemeeter/restore', 'POST');
        if (restored.skipped > 0) {
          startupWarning = '前回の設定から手動変更を検出しました。自動設定を保留しています。音声設定を確認してください。';
          skipAutoConfigure = true;
        }
      }
      if (pendingRecovery && !ctx.settings.current.audio.voicemeeterRestoreOnExit) {
        startupWarning = '前回のNAVI用ルーティングが残っています。自動設定を保留しています。';
        skipAutoConfigure = true;
        console.warn('[audio] previous NAVI routing remains; automatic configuration paused for manual recovery');
      }
      if (!skipAutoConfigure && ctx.settings.current.audio.voicemeeterAutoConfigure) {
        await request('/voicemeeter/auto-configure', 'POST');
      } else if (!skipAutoConfigure) {
        await request('/voicemeeter/snapshot', 'POST');
      }
    } catch (err) {
      console.warn('[audio] Voicemeeter configuration unavailable:', err);
    }
    try {
      await startListeners(ctx);
    } catch (err) {
      console.warn('[audio] SYSTEM/REMOTE listeners unavailable:', err);
    }
  },
  async stop(ctx) {
    running = false;
    await request('/audio/stop', 'POST').catch(() => undefined);
    if (ctx.settings.current.audio.voicemeeterRestoreOnExit) {
      await request('/voicemeeter/restore', 'POST').catch((err) => console.warn('[audio] restore failed:', err));
    }
  },
};

async function waitForVoiceService(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${VOICE_SERVICE_URL}/health`, { signal: AbortSignal.timeout(600) })).ok) return;
    } catch {
      // The supervised process may still be loading Python modules.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function settingsListener(ctx: Parameters<NonNullable<Feature['setup']>>[0]): void {
  let previous = ctx.settings.current.audio;
  ctx.settings.onChange((next) => {
    const current = next.audio;
    const captureChanged =
      current.listenSystemAudio !== previous.listenSystemAudio ||
      current.listenRemoteAudio !== previous.listenRemoteAudio ||
      current.systemInputDeviceId !== previous.systemInputDeviceId ||
      current.remoteInputDeviceId !== previous.remoteInputDeviceId;
    previous = current;
    if (running && captureChanged) void startListeners(ctx).catch((err) => console.warn('[audio] listener update failed:', err));
  });
}

