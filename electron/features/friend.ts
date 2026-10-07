import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { IPC } from '../ipc';
import type { Feature } from './Feature';

const INITIATIVE_TICK_MS = 5_000;
let initiativeTimer: ReturnType<typeof setInterval> | null = null;

/** Text input, conversation state, and the initiative tick. */
export const friendFeature: Feature = {
  name: 'friend',
  setup(ctx) {
    const { bus, windows, orchestrator, health, plugins, governor } = ctx;

    bus.on('health.changed', () => windows.push({ type: 'health', services: health.snapshot() as Record<string, boolean> }));
    bus.on('voice.transcript', (u) => windows.push({ type: 'transcript', role: 'user', text: u.text, at: u.at }));

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
      windows.push({ type: 'stopSpeech' });
      windows.sendAvatar(IPC.avatarLipSync, null);
    });
  },
  start(ctx) {
    ctx.health.start();
    initiativeTimer = setInterval(() => {
      void ctx.orchestrator.considerInitiative().catch((err) => console.error('[initiative]', err));
    }, INITIATIVE_TICK_MS);
  },
  stop(ctx) {
    if (initiativeTimer) clearInterval(initiativeTimer);
    ctx.health.stop();
  },
};
