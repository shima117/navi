import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { IPC, type FriendPush } from './ipc';
import type { SettingsStore } from './settings';

const DEV_URL = process.argv.includes('--dev') ? 'http://localhost:5173' : process.env.VITE_DEV_SERVER_URL;

export type PageName = 'index' | 'avatar';

/** Owns the main window and the transparent avatar overlay. */
export class WindowManager {
  main: BrowserWindow | null = null;
  avatar: BrowserWindow | null = null;

  constructor(private readonly settings: SettingsStore) {}

  createMain(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 760,
      minHeight: 520,
      title: 'NAVI',
      backgroundColor: '#121318',
      webPreferences: webPreferences(),
    });
    loadPage(win, 'index');
    win.on('closed', () => {
      this.main = null;
      app.quit();
    });
    this.main = win;
    return win;
  }

  createAvatar(): BrowserWindow {
    const { workArea } = screen.getPrimaryDisplay();
    const s = this.settings.current;
    const win = new BrowserWindow({
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
      show: s.avatarVisible,
      webPreferences: webPreferences(),
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(s.avatarClickThrough, { forward: true });
    loadPage(win, 'avatar');
    win.webContents.on('render-process-gone', () => {
      console.error('[avatar] renderer crashed; conversation continues');
    });
    win.on('closed', () => {
      this.avatar = null;
    });
    this.avatar = win;
    return win;
  }

  /** Push an event to the main window (no-op when it is gone). */
  push(p: FriendPush): void {
    this.sendMain(IPC.friendEvent, p);
  }

  sendMain(channel: string, payload: unknown): void {
    if (this.main && !this.main.isDestroyed()) this.main.webContents.send(channel, payload);
  }

  /** Avatar failures must never affect the conversation (§19). */
  sendAvatar(channel: string, payload: unknown): void {
    try {
      if (this.avatar && !this.avatar.isDestroyed()) this.avatar.webContents.send(channel, payload);
    } catch (err) {
      console.error('[avatar] send failed', err);
    }
  }
}

function loadPage(win: BrowserWindow, page: PageName): void {
  if (DEV_URL) void win.loadURL(`${DEV_URL}/${page}.html`);
  else void win.loadFile(path.join(__dirname, '../../dist', `${page}.html`));
}

function webPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  };
}
