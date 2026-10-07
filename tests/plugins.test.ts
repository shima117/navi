import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/EventBus';
import { PluginHost } from '../src/core/plugins/PluginHost';
import { TarkovPlugin } from '../src/plugins/tarkov/TarkovPlugin';
import type { GamePlugin } from '../src/core/plugins/GamePlugin';

const broken: GamePlugin = {
  id: 'broken',
  displayName: 'Broken',
  matchWindow: () => 1,
  onSessionStart: async () => {},
  onFrame: async () => {
    throw new Error('boom');
  },
  enrichVision: async () => {
    throw new Error('boom');
  },
  resolveTool: async () => {
    throw new Error('boom');
  },
  getPromptContext: async () => {
    throw new Error('boom');
  },
  onSessionEnd: async () => {},
};

describe('PluginHost', () => {
  it('auto-activates Tarkov from the window title and falls back to Generic', async () => {
    const host = new PluginHost(new EventBus());
    host.register(new TarkovPlugin());
    expect((await host.onWindowShared({ sourceId: 'w1', title: 'EscapeFromTarkov', kind: 'window' }))?.id).toBe(
      'escape-from-tarkov',
    );
    expect(await host.onWindowShared({ sourceId: 'w2', title: 'Google Chrome', kind: 'window' })).toBeNull();
  });

  it('isolates plugin failures', async () => {
    const host = new PluginHost(new EventBus());
    host.register(broken);
    await host.activate('broken', 0);
    await expect(host.onFrame({ frameId: 'f', capturedAt: 0, sourceId: 's', hash: '', change: 0, width: 1, height: 1 })).resolves.toBeUndefined();
    await expect(host.promptContext()).resolves.toBe('');
    await expect(host.resolveTool('x', {})).resolves.toEqual({ error: 'tool x failed' });
  });

  it('Tarkov plugin turns a referent into item facts', async () => {
    const plugin = new TarkovPlugin({
      findItem: async (name) => ({ name, neededFor: ['ハイドアウト: 医務室 Lv2'], avg24hPrice: 45000 }),
      activeTasks: async () => [],
    });
    const ctx = await plugin.enrichVision({
      frameId: 'f',
      capturedAt: 0,
      sourceId: 's',
      sourceName: 'EscapeFromTarkov',
      summary: 'インベントリ',
      referent: 'Salewa',
      confidence: 0.8,
    });
    expect(ctx.facts.join()).toContain('医務室');
    expect(ctx.facts.join()).toContain('45,000');
  });
});
