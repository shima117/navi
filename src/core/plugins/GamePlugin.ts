import type { PluginContext, PluginEvent, ScreenObservation } from '../types';
import type { FrameSummary } from '../screen/FrameSummary';

/** A window or display the user chose to share. */
export interface SharedWindow {
  sourceId: string;
  title: string;
  kind: 'screen' | 'window';
}

export interface PluginSessionContext {
  now: number;
  log(message: string): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
}

/** Game plugin contract (design doc §15). Adding a game means adding one of these. */
export interface GamePlugin {
  id: string;
  displayName: string;
  /** Tools the plugin exposes to the LLM via needs_tool. */
  tools?: ToolDefinition[];

  /** 0..1 confidence that this plugin applies to the shared window. */
  matchWindow(window: SharedWindow): number;
  onSessionStart(ctx: PluginSessionContext): Promise<void>;
  onFrame(frame: FrameSummary): Promise<PluginEvent[]>;
  enrichVision(observation: ScreenObservation): Promise<PluginContext>;
  resolveTool(name: string, args: unknown): Promise<unknown>;
  getPromptContext(): Promise<string>;
  onSessionEnd(): Promise<void>;
  /**
   * Requests from the plugin's own UI (Games tab), e.g. task progress edits.
   * Works whether or not the plugin is the active one.
   */
  handleUiRequest?(method: string, args: unknown): Promise<unknown>;
}
