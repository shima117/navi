import { ipcMain } from 'electron';
import { IPC } from '../ipc';
import type { Feature } from './Feature';

/** Transparent, click-through avatar overlay (§12). */
export const avatarFeature: Feature = {
  name: 'avatar',
  setup(ctx) {
    const { bus, windows, settings } = ctx;

    bus.on('avatar.performance', (cue) => windows.sendAvatar(IPC.avatarPerformance, cue));

    // The main window plays the audio, then forwards the lip-sync timeline here at playback start.
    ipcMain.on(IPC.avatarLipSync, (_e, frames: unknown) => windows.sendAvatar(IPC.avatarLipSync, frames));

    ipcMain.handle(IPC.avatarSetVisible, async (_e, visible: boolean) => {
      await settings.patch({ avatarVisible: visible });
      if (visible) {
        if (!windows.avatar) windows.createAvatar();
        windows.avatar?.showInactive();
      } else {
        windows.avatar?.hide();
      }
    });

    ipcMain.handle(IPC.avatarSetClickThrough, async (_e, on: boolean) => {
      await settings.patch({ avatarClickThrough: on });
      windows.avatar?.setIgnoreMouseEvents(on, { forward: true });
    });
  },
  start(ctx) {
    if (ctx.settings.current.avatarVisible) ctx.windows.createAvatar();
  },
};
