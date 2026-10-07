import type { ResourceGovernor } from '../resource/ResourceGovernor';

/** Model selection, switchable at runtime (design doc §3). */
export interface ModelConfig {
  chat: string;
  chatAlternate: string;
  vision: string;
  visionLarge: string;
}

export const DEFAULT_MODELS: ModelConfig = {
  chat: 'dolphin3:8b',
  chatAlternate: 'qwen3:8b',
  vision: 'qwen3-vl:4b',
  visionLarge: 'qwen3-vl:8b',
};

/** Below this confidence the 4B result may be escalated to 8B. */
export const VISION_ESCALATION_CONFIDENCE = 0.45;

export class ModelRouter {
  private useAlternateChat = false;

  constructor(
    private readonly governor: ResourceGovernor,
    private models: ModelConfig = DEFAULT_MODELS,
  ) {}

  setModels(models: Partial<ModelConfig>): void {
    this.models = { ...this.models, ...models };
  }

  setUseAlternateChat(on: boolean): void {
    this.useAlternateChat = on;
  }

  chatModel(): { model: string; keepAlive: string } {
    return {
      model: this.useAlternateChat ? this.models.chatAlternate : this.models.chat,
      keepAlive: this.governor.profile.chatKeepAlive,
    };
  }

  visionModel(opts: { escalate?: boolean } = {}): { model: string; keepAlive: string } {
    const large = opts.escalate === true && this.governor.profile.allowLargeVision;
    return {
      model: large ? this.models.visionLarge : this.models.vision,
      keepAlive: this.governor.profile.visionKeepAlive,
    };
  }

  shouldEscalate(confidence: number): boolean {
    return confidence < VISION_ESCALATION_CONFIDENCE && this.governor.profile.allowLargeVision;
  }
}
