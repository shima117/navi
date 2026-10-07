import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { IPC, type FriendPush } from './ipc';
import type { SettingsStore } from './settings';
import { normalizeTextSettings, type DesktopTextState, type OverlayCommand, type TextMode, type TextStyle } from '../src/core/desktopText/DesktopText';

const DEV_URL = process.argv.includes('--dev') ? 'http://localhost:5173' : process.env.VITE_DEV_SERVER_URL;

export type PageName = 'index' | 'avatar' | 'text-overlay';

/** Owns the main window and the transparent avatar overlay. */
export class WindowManager {
  main: BrowserWindow | null = null;
  avatar: BrowserWindow | null = null;
  textOverlay: BrowserWindow | null = null;
  private text: DesktopTextState;
  private lastAnswer = '';
  private pageCount = 1;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private placedTextAt: { x: number; y: number } | null = null;
  private movedTextTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly settings: SettingsStore) {
    this.text = { revision: 0, visible: false, text: '', mode: 'ANSWER', style: 'NORMAL', page: 0, settings: normalizeTextSettings(settings.current.desktopText) };
  }

  get textState(): DesktopTextState { return structuredClone(this.text); }

  rememberAnswer(text: string): void { this.lastAnswer = text.slice(0, 20000); }

  createTextOverlay(): BrowserWindow {
    if (this.textOverlay && !this.textOverlay.isDestroyed()) return this.textOverlay;
    const win = new BrowserWindow({
      width: 640, height: 400, transparent: true, frame: false, hasShadow: false,
      resizable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false,
      webPreferences: { ...webPreferences(), additionalArguments: ['--navi-text-overlay'] },
    });
    this.textOverlay = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    this.configureText();
    loadPage(win, 'text-overlay');
    win.webContents.on('did-finish-load', () => this.publishText());
    win.webContents.on('render-process-gone', () => {
      console.error('[text-overlay] renderer crashed; conversation continues');
      win.destroy();
    });
    win.on('closed', () => { if (this.textOverlay === win) this.textOverlay = null; });
    win.on('move', () => {
      if (this.movedTextTimer) clearTimeout(this.movedTextTimer);
      this.movedTextTimer = setTimeout(() => this.saveTextPosition(), 200);
    });
    return win;
  }

  configureText(): void {
    this.text.revision++;
    this.text.settings = normalizeTextSettings(this.settings.current.desktopText);
    const win = this.textOverlay;
    if (!win || win.isDestroyed()) return;
    const s = this.text.settings;
    const area = screen.getDisplayMatching(this.avatar?.getBounds() ?? this.main?.getBounds() ?? screen.getPrimaryDisplay().workArea).workArea;
    const width = Math.min(s.maxWidth, area.width);
    const height = Math.min(Math.ceil(s.fontSize * s.lineHeight * (s.maxLines + 1) + 32), area.height);
    let x = area.x + (area.width - width) / 2;
    let y = area.y + 24;
    if (s.position === 'BOTTOM_CENTER') y = area.y + area.height - height - 24;
    if (s.position === 'TOP_LEFT') x = area.x + 24;
    if (s.position === 'TOP_RIGHT') x = area.x + area.width - width - 24;
    if (s.position === 'AVATAR_SIDE') {
      const avatar = this.avatar?.getBounds();
      x = avatar ? avatar.x - width - 16 : area.x + area.width - width - 400;
      y = avatar?.y ?? area.y + area.height - height - 24;
    }
    if (s.position === 'FREE') { x = s.x; y = s.y; }
    // Recover off-screen positions after monitor removal, without changing saved coordinates.
    x = Math.max(area.x, Math.min(area.x + area.width - width, x));
    y = Math.max(area.y, Math.min(area.y + area.height - height, y));
    this.placedTextAt = { x: Math.round(x), y: Math.round(y) };
    win.setBounds({ ...this.placedTextAt, width: Math.round(width), height: Math.round(height) });
    win.setIgnoreMouseEvents(s.clickThrough, { forward: true });
    win.setContentProtection(!s.captureIncluded);
    this.publishText();
  }

  showText(text: string, mode: TextMode = 'ANSWER', style: TextStyle = 'NORMAL'): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    const retainPage = mode === 'TASK_STATUS' && this.text.mode === 'TASK_STATUS' && this.text.visible;
    this.text = { ...this.text, revision: this.text.revision + 1, text: text.slice(0, 20000), visible: true, mode, style, page: retainPage ? this.text.page : 0 };
    if (!retainPage) this.pageCount = 1;
    const win = this.createTextOverlay();
    this.publishText();
    win.showInactive();
  }

  textLayout(revision: number, pages: number): void {
    if (revision !== this.text.revision || !Number.isInteger(pages) || pages < 1 || pages > 20001) return;
    this.pageCount = pages;
    if (this.text.page >= pages) { this.text.page = pages - 1; this.publishText(); }
    const expires = this.text.mode === 'TEMPORARY' || this.text.mode === 'TRANSCRIPT' || (this.text.mode === 'ANSWER' && pages === 1);
    if (!expires && this.expiry) { clearTimeout(this.expiry); this.expiry = null; }
    if (expires && this.text.visible && !this.expiry) this.expiry = setTimeout(() => this.hideText(), this.text.settings.temporarySeconds * 1000);
  }

  hideText(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    this.text.visible = false;
    this.textOverlay?.hide();
    this.publishText();
  }

  saveTextPosition(): void {
    const win = this.textOverlay;
    if (!win || win.isDestroyed() || this.settings.current.desktopText.clickThrough) return;
    const { x, y } = win.getBounds();
    if (this.placedTextAt?.x === x && this.placedTextAt.y === y) return;
    this.placedTextAt = { x, y };
    void this.settings.patch({ desktopText: { ...this.settings.current.desktopText, position: 'FREE', x, y } })
      .catch((err) => console.error('[text-overlay] position save failed', err));
  }

  textCommand(command: OverlayCommand): void {
    switch (command) {
      case 'show': this.showText(this.lastAnswer || 'まだ表示できる返答はありません。'); break;
      case 'hide': this.hideText(); break;
      case 'next': this.text.page = Math.min(this.pageCount - 1, this.text.page + 1); this.publishText(); break;
      case 'previous': this.text.page = Math.max(0, this.text.page - 1); this.publishText(); break;
      case 'fix':
        if (this.expiry) clearTimeout(this.expiry);
        this.expiry = null;
        this.text.mode = 'MEMO';
        this.publishText();
        break;
      case 'bigger': case 'smaller': case 'right': {
        const s = this.settings.current.desktopText;
        const patch = command === 'right' ? { position: 'TOP_RIGHT' as const } : { fontSize: s.fontSize + (command === 'bigger' ? 4 : -4) };
        void this.settings.patch({ desktopText: { ...s, ...patch } }).catch((err) => console.error('[text-overlay] settings save failed', err));
        break;
      }
    }
  }

  stopText(): void {
    if (this.movedTextTimer) clearTimeout(this.movedTextTimer);
    this.movedTextTimer = null;
    this.hideText();
    this.textOverlay?.destroy();
  }

  private publishText(): void {
    try {
      const win = this.textOverlay;
      if (win && !win.isDestroyed()) win.webContents.send(IPC.textState, this.textState);
    } catch (err) { console.error('[text-overlay] send failed', err); }
  }

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
