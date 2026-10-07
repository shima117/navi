import type { EventBus } from '../events/EventBus';
import type { FrameSummary } from '../screen/FrameSummary';
import type { PluginContext, ScreenObservation } from '../types';
import type { GamePlugin, SharedWindow } from './GamePlugin';

export const MATCH_THRESHOLD = 0.6;

/**
 * Owns plugin lifecycle. Every plugin call is isolated: a crashing plugin
 * degrades to Generic mode instead of breaking the conversation.
 */
export class PluginHost {
  private plugins = new Map<string, GamePlugin>();
  private active: GamePlugin | null = null;
  private manualId: string | null = null;

  constructor(private readonly bus: EventBus) {}

  register(plugin: GamePlugin): void {
    this.plugins.set(plugin.id, plugin);
  }

  list(): Array<{ id: string; displayName: string; active: boolean }> {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      displayName: p.displayName,
      active: p === this.active,
    }));
  }

  get activePlugin(): GamePlugin | null {
    return this.active;
  }

  /** Force a plugin (or null for Generic). Overrides auto-detection until cleared. */
  async activate(id: string | null, now = Date.now()): Promise<void> {
    this.manualId = id;
    await this.switchTo(id ? (this.plugins.get(id) ?? null) : null, now);
  }

  /** Auto-select a plugin for the newly shared window. */
  async onWindowShared(window: SharedWindow, now = Date.now()): Promise<GamePlugin | null> {
    if (this.manualId !== null) return this.active;
    let best: GamePlugin | null = null;
    let bestScore = MATCH_THRESHOLD;
    for (const p of this.plugins.values()) {
      const s = await this.safe(p, () => Promise.resolve(p.matchWindow(window)), 0);
      if (s >= bestScore) {
        best = p;
        bestScore = s;
      }
    }
    await this.switchTo(best, now);
    return best;
  }

  async onFrame(frame: FrameSummary): Promise<void> {
    const p = this.active;
    if (!p) return;
    const events = await this.safe(p, () => p.onFrame(frame), []);
    for (const e of events) this.bus.emit('plugin.event', e);
  }

  async enrich(observation: ScreenObservation): Promise<PluginContext | null> {
    const p = this.active;
    if (!p) return null;
    const ctx = await this.safe(p, () => p.enrichVision(observation), null);
    if (ctx) this.bus.emit('plugin.context', ctx);
    return ctx;
  }

  async promptContext(): Promise<string> {
    const p = this.active;
    return p ? this.safe(p, () => p.getPromptContext(), '') : '';
  }

  async resolveTool(name: string, args: unknown): Promise<unknown> {
    const p = this.active;
    if (!p) return { error: 'no active plugin' };
    return this.safe(p, () => p.resolveTool(name, args), { error: `tool ${name} failed` });
  }

  private async switchTo(next: GamePlugin | null, now: number): Promise<void> {
    if (next === this.active) return;
    const prev = this.active;
    this.active = null;
    if (prev) await this.safe(prev, () => prev.onSessionEnd(), undefined);
    if (next) {
      await this.safe(next, () => next.onSessionStart({ now, log: (m) => console.log(`[${next.id}] ${m}`) }), undefined);
      this.active = next;
    }
  }

  private async safe<T>(plugin: GamePlugin, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      console.error(`[PluginHost] plugin "${plugin.id}" failed:`, err);
      return fallback;
    }
  }
}
