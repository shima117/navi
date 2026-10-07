import { app, dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NaviEvents } from '../../src/core/events/EventBus';
import {
  diagnosticsFileName,
  HealthTimeline,
  type DiagnosticsExportResult,
  type DiagnosticsSnapshot,
} from '../../src/core/telemetry/DiagnosticsReport';
import { attachMetrics, Metrics, RESPONSE_TARGET_MS } from '../../src/core/telemetry/Metrics';
import { errorMessage } from '../../src/core/telemetry/redact';
import { ResponseLatencyTracker } from '../../src/core/telemetry/ResponseLatency';
import { RotatingJsonlLog, toTelemetryRecord, type LogFs } from '../../src/core/telemetry/TelemetryLog';
import type { AppContext } from '../context';
import { IPC, type VoiceServiceEvent } from '../ipc';
import type { Feature } from './Feature';
import { readVram, resourceDiagnostics } from './resource';
import { managedProcessEntries, restartManagedProcess } from './watchdog';

/**
 * Local-only telemetry and the Diagnostics tab (PR-10). Metrics live in RAM;
 * with telemetryToFile they are also appended to userData/logs. Nothing
 * leaves the machine, and nothing recorded contains text or images (§20).
 */
const metrics = new Metrics();
const health = new HealthTimeline();
let log: RotatingJsonlLog | null = null;

const nodeLogFs: LogFs = {
  mkdir: async (dir) => {
    await fs.mkdir(dir, { recursive: true });
  },
  size: async (file) => {
    try {
      return (await fs.stat(file)).size;
    } catch {
      return null;
    }
  },
  append: (file, data) => fs.appendFile(file, data, 'utf8'),
  rename: (from, to) => fs.rename(from, to),
  remove: (file) => fs.rm(file, { force: true }),
};

function logDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

async function snapshot(ctx: AppContext): Promise<DiagnosticsSnapshot> {
  const s = ctx.settings.current;
  return {
    format: 'navi-diagnostics',
    version: 1,
    generatedAt: Date.now(),
    app: {
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    services: health.list(),
    processes: managedProcessEntries(ctx),
    metrics: metrics.snapshot(),
    responseTargetMs: RESPONSE_TARGET_MS,
    resource: resourceDiagnostics(ctx, await readVram()),
    telemetry: { toFile: s.telemetryToFile, logDir: s.telemetryToFile ? logDir() : null },
  };
}

async function exportSnapshot(ctx: AppContext): Promise<DiagnosticsExportResult> {
  try {
    const data = await snapshot(ctx);
    const options = {
      title: '診断情報を書き出す',
      defaultPath: path.join(app.getPath('documents'), diagnosticsFileName(data.generatedAt)),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const main = ctx.windows.main;
    const res = main && !main.isDestroyed() ? await dialog.showSaveDialog(main, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return { saved: false, path: null };
    await fs.writeFile(res.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return { saved: true, path: res.filePath };
  } catch (err) {
    console.error('[diagnostics] export failed', err);
    return { saved: false, path: null, error: errorMessage(err) };
  }
}

export const diagnosticsFeature: Feature = {
  name: 'diagnostics',
  setup(ctx) {
    const { bus, settings } = ctx;
    attachMetrics(bus, metrics);
    bus.on('health.changed', (h) => health.record(h.service, h.ok, Date.now()));

    // Response / TTS latency. Playback and end-of-speech arrive over IPC, so listen
    // there too (ipcMain.on allows several listeners; the voice feature keeps its own).
    const latency = new ResponseLatencyTracker((kind, ms) => bus.emit('metrics.timing', { kind, ms, at: Date.now() }));
    bus.on('voice.transcript', (u) => latency.userUtterance(u.at, u.source));
    bus.on('friend.speak', () => latency.naviSpeak(Date.now(), ctx.health.isHealthy('tts')));
    bus.on('friend.silent', () => latency.naviSilent());
    ipcMain.on(IPC.voicePlayback, (_e, state: 'started' | 'finished') => {
      if (state === 'started') latency.playbackStarted(Date.now());
    });
    ipcMain.on(IPC.voiceEvent, (_e, ev: VoiceServiceEvent) => {
      if (ev?.type === 'speech_ended' && typeof ev.at === 'number') latency.userSpeechEnded(ev.at);
    });

    // Optional JSONL log: only whitelisted numeric/enum records reach the disk.
    settings.onChange((next) => {
      if (next.telemetryToFile && !log) log = new RotatingJsonlLog(nodeLogFs, logDir(), { join: path.join });
      if (!next.telemetryToFile) log = null;
    });
    const toFile = <K extends Parameters<typeof toTelemetryRecord>[0]>(type: K) =>
      bus.on(type, (payload: NaviEvents[K]) => {
        if (!log) return;
        const record = toTelemetryRecord(type, payload);
        if (record) log.write(record);
      });
    toFile('metrics.timing');
    toFile('metrics.error');
    toFile('metrics.initiative');
    toFile('resource.mode');
    toFile('session.started');
    toFile('session.ended');

    ipcMain.handle(IPC.diagnosticsGet, () => snapshot(ctx));
    ipcMain.handle(IPC.diagnosticsRestartProcess, (_e, id: unknown) => typeof id === 'string' && restartManagedProcess(id));
    ipcMain.handle(IPC.diagnosticsExport, () => exportSnapshot(ctx));
  },
  async stop() {
    await log?.flush();
  },
};
