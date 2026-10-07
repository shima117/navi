import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/EventBus';
import { PluginHost } from '../src/core/plugins/PluginHost';
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
  it('auto-activates a registered plugin and falls back to Generic', async () => {
    const host = new PluginHost(new EventBus());
    host.register({ ...broken, id: 'test-game', matchWindow: (w) => w.title === 'Test Game' ? 1 : 0, onFrame: async () => [], getPromptContext: async () => '' });
    expect((await host.onWindowShared({ sourceId: 'w1', title: 'Test Game', kind: 'window' }))?.id).toBe(
      'test-game',
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

  it('an empty host has no game-specific tools or facts', async () => {
    const host = new PluginHost(new EventBus());
    expect(host.list()).toEqual([]);
    const ctx = await host.enrich({
      frameId: 'f',
      capturedAt: 0,
      sourceId: 's',
      sourceName: 'Test Game',
      summary: 'インベントリ',
      referent: 'Salewa',
      confidence: 0.8,
    });
    expect(ctx).toBeNull();
    expect(await host.resolveTool('item', {})).toEqual({ error: 'no active plugin' });
  });
});
