import { ipcMain } from 'electron';
import { IPC, type NaviSettings } from '../ipc';
import type { Feature } from './Feature';

export const settingsFeature: Feature = {
  name: 'settings',
  setup(ctx) {
    const { settings, governor, router } = ctx;
    settings.onChange((s) => {
      governor.setMode(s.resourceMode);
      router.setUseAlternateChat(s.useAlternateChatModel);
    });
    ipcMain.handle(IPC.settingsGet, () => settings.current);
    ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<NaviSettings>) => settings.patch(patch));
  },
};
