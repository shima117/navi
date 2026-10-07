import type { GamePlugin, PluginSessionContext, SharedWindow } from '../../core/plugins/GamePlugin';
import type { FrameSummary } from '../../core/screen/FrameSummary';
import type { PluginContext, PluginEvent, ScreenObservation } from '../../core/types';

/**
 * Escape from Tarkov plugin (design doc §15.1).
 *
 * Skeleton only: the task / item / map domain from the existing Tarkov
 * Assistant is migrated into `plugins/tarkov/{domain,data,ui}` in PR-08.
 * Until then the knowledge adapter is injectable so it can be wired to the
 * existing tarkov.dev catalog without touching Friend Core.
 */
export interface TarkovKnowledge {
  /** Look up an item by (possibly OCR-noisy) name. */
  findItem(name: string): Promise<{ name: string; neededFor: string[]; avg24hPrice?: number } | null>;
  activeTasks(): Promise<string[]>;
}

export class TarkovPlugin implements GamePlugin {
  readonly id = 'escape-from-tarkov';
  readonly displayName = 'Escape from Tarkov';
  readonly tools = [
    { name: 'tarkov_item', description: 'アイテム名から用途(タスク/ハイドアウト)と相場を調べる。args: {"name": string}' },
    { name: 'tarkov_tasks', description: '現在進行中のタスク一覧。args: {}' },
  ];

  private lastHash: string | null = null;

  constructor(private readonly knowledge: TarkovKnowledge | null = null) {}

  matchWindow(window: SharedWindow): number {
    return /escape\s*from\s*tarkov|escapefromtarkov|\btarkov\b/i.test(window.title) ? 0.95 : 0;
  }

  async onSessionStart(ctx: PluginSessionContext): Promise<void> {
    this.lastHash = null;
    ctx.log(this.knowledge ? 'knowledge adapter ready' : 'running without knowledge adapter');
  }

  async onFrame(frame: FrameSummary): Promise<PluginEvent[]> {
    // Raid event detection (death screen, extraction, etc.) lands in PR-08.
    this.lastHash = frame.hash;
    return [];
  }

  async enrichVision(observation: ScreenObservation): Promise<PluginContext> {
    const facts: string[] = [];
    if (this.knowledge && observation.referent) {
      const item = await this.knowledge.findItem(observation.referent);
      if (item) {
        facts.push(
          item.neededFor.length
            ? `${item.name} は ${item.neededFor.join('、')} で使う`
            : `${item.name} は現在のタスク/ハイドアウトでは使わない`,
        );
        if (item.avg24hPrice) facts.push(`${item.name} の相場は約${item.avg24hPrice.toLocaleString()}₽`);
      }
    }
    return { pluginId: this.id, facts };
  }

  async resolveTool(name: string, args: unknown): Promise<unknown> {
    if (!this.knowledge) return { error: 'Tarkov knowledge is not available yet' };
    if (name === 'tarkov_item') {
      const itemName = (args as { name?: unknown } | null)?.name;
      return typeof itemName === 'string' ? ((await this.knowledge.findItem(itemName)) ?? { error: 'not found' }) : { error: 'name required' };
    }
    if (name === 'tarkov_tasks') return { tasks: await this.knowledge.activeTasks() };
    return { error: `unknown tool ${name}` };
  }

  async getPromptContext(): Promise<string> {
    const tools = this.tools.map((t) => `${t.name}: ${t.description}`).join(' / ');
    return `Escape from Tarkov をプレイ中。必要なら needs_tool で次を使える: ${tools}`;
  }

  async onSessionEnd(): Promise<void> {
    this.lastHash = null;
  }
}
