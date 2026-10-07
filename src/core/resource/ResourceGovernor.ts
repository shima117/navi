/**
 * Resource profiles for a 12 GB GPU shared with a running game (design doc §4).
 */
export type ResourceMode = 'GAME_PRIORITY' | 'BALANCED' | 'DESKTOP_CHAT';

export interface ResourceProfile {
  chatKeepAlive: string;
  visionKeepAlive: string;
  /** Whether the 8B vision model may be used. */
  allowLargeVision: boolean;
  sttDevice: 'cpu' | 'cuda';
  ttsDevice: 'cpu';
  sampleFps: number;
  /** Max Vision requests per second. */
  visionMaxRps: number;
}

export const PROFILES: Record<ResourceMode, ResourceProfile> = {
  GAME_PRIORITY: {
    chatKeepAlive: '30m',
    visionKeepAlive: '30s',
    allowLargeVision: false,
    sttDevice: 'cpu',
    ttsDevice: 'cpu',
    sampleFps: 2,
    visionMaxRps: 0.2,
  },
  BALANCED: {
    chatKeepAlive: '30m',
    visionKeepAlive: '120s',
    allowLargeVision: false,
    sttDevice: 'cuda',
    ttsDevice: 'cpu',
    sampleFps: 4,
    visionMaxRps: 0.5,
  },
  DESKTOP_CHAT: {
    chatKeepAlive: '30m',
    visionKeepAlive: '5m',
    allowLargeVision: true,
    sttDevice: 'cuda',
    ttsDevice: 'cpu',
    sampleFps: 4,
    visionMaxRps: 1,
  },
};

export class ResourceGovernor {
  private lastVisionAt = -Infinity;

  constructor(private mode: ResourceMode = 'BALANCED') {}

  get profile(): ResourceProfile {
    return PROFILES[this.mode];
  }

  get currentMode(): ResourceMode {
    return this.mode;
  }

  setMode(mode: ResourceMode): void {
    this.mode = mode;
  }

  /**
   * Rate-limit Vision calls. High-priority requests (the user explicitly said
   * "これ") always pass; background requests respect visionMaxRps.
   */
  tryAcquireVision(now: number, highPriority: boolean): boolean {
    const minGap = 1000 / this.profile.visionMaxRps;
    if (!highPriority && now - this.lastVisionAt < minGap) return false;
    this.lastVisionAt = now;
    return true;
  }
}
