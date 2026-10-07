import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_AUDIO_SETTINGS, DEFAULT_SETTINGS, type NaviSettings } from './ipc';

type Listener = (next: NaviSettings, prev: NaviSettings) => void;

/** Persistent user settings (userData/settings.json). */
export class SettingsStore {
  private value: NaviSettings = { ...DEFAULT_SETTINGS };
  private listeners = new Set<Listener>();

  private get file(): string {
    return path.join(app.getPath('userData'), 'settings.json');
  }

  get current(): NaviSettings {
    return this.value;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<NaviSettings>;
      this.value = { ...DEFAULT_SETTINGS, ...raw, audio: { ...DEFAULT_AUDIO_SETTINGS, ...(raw.audio ?? {}) } };
      // PR-11 migration: the old top-level mic setting becomes the direct USER_MIC input.
      if (!raw.audio?.userMicDeviceId && raw.micDeviceId) this.value.audio.userMicDeviceId = raw.micDeviceId;
      // Migrate the old generated default; explicit custom names remain untouched.
      if (this.value.userName === 'ユーザー') this.value.userName = 'しま';
    } catch {
      this.value = { ...DEFAULT_SETTINGS };
    }
  }

  async patch(patch: Partial<NaviSettings>): Promise<NaviSettings> {
    const prev = this.value;
    this.value = { ...prev, ...patch, audio: patch.audio ? { ...prev.audio, ...patch.audio } : prev.audio };
    for (const l of this.listeners) {
      try {
        l(this.value, prev);
      } catch (err) {
        console.error('[settings] listener failed', err);
      }
    }
    await this.save();
    return this.value;
  }

  /** Called on every change (and once immediately with the current value). */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.value, this.value);
    return () => this.listeners.delete(listener);
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.value, null, 2));
  }
}
