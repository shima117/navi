import { app } from 'electron';
import { createContext } from './context';
import { FEATURES } from './features';
import { SettingsStore } from './settings';
import { WindowManager } from './windows';

app.whenReady().then(async () => {
  const settings = new SettingsStore();
  await settings.load();
  const windows = new WindowManager(settings);
  const ctx = createContext(settings, windows);

  for (const f of FEATURES) await f.setup(ctx);
  windows.createMain();
  ctx.bus.emit('session.started', { at: Date.now() });
  for (const f of FEATURES) {
    try {
      await f.start?.(ctx);
    } catch (err) {
      console.error(`[feature:${f.name}] start failed`, err);
    }
  }

  let stopping = false;
  app.on('before-quit', () => {
    if (stopping) return;
    stopping = true;
    ctx.bus.emit('session.ended', { at: Date.now() });
    for (const f of [...FEATURES].reverse()) {
      try {
        void f.stop?.(ctx);
      } catch (err) {
        console.error(`[feature:${f.name}] stop failed`, err);
      }
    }
  });
});
