import { ipcMain } from 'electron';
import { IPC } from '../ipc';
import type { Feature } from './Feature';

/** Plugin list / manual activation / plugin-specific UI calls (§15). */
export const pluginsFeature: Feature = {
  name: 'plugins',
  setup(ctx) {
    const { plugins, windows } = ctx;
    ipcMain.handle(IPC.pluginList, () => plugins.list());
    ipcMain.handle(IPC.pluginActivate, async (_e, id: string | null) => {
      await plugins.activate(id);
      windows.push({ type: 'plugin', active: plugins.activePlugin?.id ?? null });
    });
    ipcMain.handle(IPC.pluginGetState, () => ({ active: plugins.activePlugin?.id ?? null }));
    ipcMain.handle(IPC.pluginInvoke, (_e, pluginId: string, method: string, args: unknown) =>
      plugins.invokeUi(pluginId, method, args),
    );
  },
};
