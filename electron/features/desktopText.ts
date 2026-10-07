import { ipcMain } from 'electron';
import { IPC } from '../ipc';
import type { Feature } from './Feature';
import type { OverlayCommand, TextMode } from '../../src/core/desktopText/DesktopText';
import { formatTaskSnapshots } from '../../src/core/tasks/TaskSnapshotPublisher';

const COMMANDS = new Set<OverlayCommand>(['show', 'hide', 'next', 'previous', 'bigger', 'smaller', 'right', 'fix']);
const MODES = new Set<TextMode>(['ANSWER', 'TASK_STATUS', 'RESULT', 'MEMO', 'TRANSCRIPT', 'TEMPORARY']);

export const desktopTextFeature: Feature = {
  name: 'desktopText',
  setup(ctx) {
    const { windows, settings, tasks, bus } = ctx;
    const allowed = (id: number) => id === windows.main?.webContents.id || id === windows.textOverlay?.webContents.id;
    ipcMain.handle(IPC.textGetState, (event) => {
      if (!allowed(event.sender.id)) throw new Error('Text overlay access denied');
      return windows.textState;
    });
    ipcMain.handle(IPC.textShow, (event, text: unknown, mode: TextMode) => {
      if (event.sender.id !== windows.main?.webContents.id) throw new Error('Text display access denied');
      if (typeof text !== 'string' || text.length > 20000 || !MODES.has(mode)) throw new Error('Invalid display content');
      windows.showText(text, mode);
    });
    ipcMain.handle(IPC.textCommand, (event, command: OverlayCommand) => {
      if (!allowed(event.sender.id) || !COMMANDS.has(command)) throw new Error('Invalid display command');
      windows.textCommand(command);
    });
    ipcMain.on(IPC.textMoved, (event) => {
      if (event.sender.id !== windows.textOverlay?.webContents.id || settings.current.desktopText.clickThrough) return;
      windows.saveTextPosition();
    });
    ipcMain.on(IPC.textLayout, (event, revision: number, pages: number) => {
      if (event.sender.id === windows.textOverlay?.webContents.id) windows.textLayout(revision, pages);
    });
    ipcMain.handle(IPC.tasksList, (event) => {
      if (event.sender.id !== windows.main?.webContents.id) throw new Error('Task access denied');
      return tasks.list();
    });
    settings.onChange(() => windows.configureText());
    bus.on('task.snapshot', ({ snapshot, report }) => tasks.update(snapshot, report));
  },
  start(ctx) {
    ctx.windows.createTextOverlay();
    ctx.tasksOnPublish = (snapshot) => {
      ctx.windows.sendMain(IPC.taskSnapshot, snapshot);
      if (ctx.windows.textState.visible && ctx.windows.textState.mode === 'TASK_STATUS') {
        ctx.windows.showText(formatTaskSnapshots(ctx.tasks.list()), 'TASK_STATUS', 'TASK_STATUS');
      }
    };
  },
  stop(ctx) {
    ctx.tasksOnPublish = undefined;
    ctx.tasks.dispose();
    ctx.windows.stopText();
  },
};
