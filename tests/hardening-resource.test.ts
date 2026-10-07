import { describe, expect, it } from 'vitest';
import { decideResourceMode, transitionActions } from '../src/core/resource/ResourcePolicy';
import { parseNvidiaSmi } from '../src/core/telemetry/vram';

describe('decideResourceMode', () => {
  const base = { auto: true, manualMode: 'BALANCED' as const, gameActive: false, sharing: false };

  it('game plugin active → GAME_PRIORITY (shared or not)', () => {
    expect(decideResourceMode({ ...base, gameActive: true, sharing: true })).toEqual({ mode: 'GAME_PRIORITY', reason: 'game' });
    expect(decideResourceMode({ ...base, gameActive: true })).toEqual({ mode: 'GAME_PRIORITY', reason: 'game' });
  });

  it('sharing a non-game source → BALANCED', () => {
    expect(decideResourceMode({ ...base, sharing: true })).toEqual({ mode: 'BALANCED', reason: 'sharing' });
  });

  it('not sharing → DESKTOP_CHAT', () => {
    expect(decideResourceMode(base)).toEqual({ mode: 'DESKTOP_CHAT', reason: 'idle' });
  });

  it('manual mode wins when auto is off', () => {
    expect(decideResourceMode({ ...base, auto: false, manualMode: 'DESKTOP_CHAT', gameActive: true, sharing: true })).toEqual({
      mode: 'DESKTOP_CHAT',
      reason: 'manual',
    });
  });
});

describe('transitionActions', () => {
  it('unloads the large vision model only when entering GAME_PRIORITY', () => {
    expect(transitionActions('DESKTOP_CHAT', 'GAME_PRIORITY').unloadLargeVision).toBe(true);
    expect(transitionActions('BALANCED', 'GAME_PRIORITY').unloadLargeVision).toBe(true);
    expect(transitionActions(null, 'GAME_PRIORITY').unloadLargeVision).toBe(true);
    expect(transitionActions('GAME_PRIORITY', 'GAME_PRIORITY').unloadLargeVision).toBe(false);
    expect(transitionActions('GAME_PRIORITY', 'BALANCED').unloadLargeVision).toBe(false);
    expect(transitionActions(null, 'DESKTOP_CHAT').unloadLargeVision).toBe(false);
  });
});

describe('parseNvidiaSmi', () => {
  it('reads used/total MiB of the first GPU', () => {
    expect(parseNvidiaSmi('7812, 12282\n')).toEqual({ usedMiB: 7812, totalMiB: 12282, gpus: 1 });
    expect(parseNvidiaSmi('100, 8192\r\n2000, 24576\r\n')).toEqual({ usedMiB: 100, totalMiB: 8192, gpus: 2 });
  });

  it('returns null for anything else', () => {
    expect(parseNvidiaSmi('')).toBeNull();
    expect(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.')).toBeNull();
    expect(parseNvidiaSmi('[N/A], [N/A]')).toBeNull();
    expect(parseNvidiaSmi('0, 0')).toBeNull();
  });
});
