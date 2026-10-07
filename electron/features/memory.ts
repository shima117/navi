import type { Feature } from './Feature';

/** Memory persistence policy (§6.5). Long-term storage lands with the SQLite store (PR-09). */
export const memoryFeature: Feature = {
  name: 'memory',
  setup(ctx) {
    ctx.bus.on('memory.write', (m) => {
      if (ctx.settings.current.persistMemory) ctx.memory.write(m.text, 'long', Date.now());
    });
  },
  stop(ctx) {
    if (!ctx.settings.current.persistMemory) ctx.memory.clearSession();
  },
};
