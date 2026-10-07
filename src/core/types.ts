// Shared domain types for the NAVI Friend Core.
// Nothing in here may reference a specific game (design doc §25).

export type Temperature = 'thin' | 'normal' | 'dense';

export const EMOTIONS = [
  'neutral',
  'smile',
  'happy',
  'embarrassed',
  'worried',
  'unimpressed',
  'annoyed',
  'tired',
  'sad',
  'smug',
  'surprised',
  'focused',
  'confused',
  'relieved',
  'concerned',
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const GESTURES = [
  'still',
  'small_nod',
  'nod',
  'small_shake',
  'shake',
  'tilt_left',
  'tilt_right',
  'look_screen',
  'look_user',
  'look_away',
  'lean_forward',
  'recoil',
  'sigh',
  'tiny_shrug',
] as const;
export type Gesture = (typeof GESTURES)[number];

export type Gaze = 'screen' | 'user' | 'away';

export type TopicAction = 'continue' | 'shift' | 'drop';

/** A single user turn, from STT or the text box. */
export interface UserUtterance {
  id: string;
  text: string;
  source: 'voice' | 'text';
  at: number;
}

/** Result of looking at the shared screen (Vision model and/or OCR). */
export interface ScreenObservation {
  frameId: string;
  capturedAt: number;
  sourceId: string;
  sourceName: string;
  summary: string;
  ocrText?: string;
  /** What "これ" most likely refers to, if a reference was resolved. */
  referent?: string;
  confidence: number;
}

/** Context a GamePlugin contributes to a turn. */
export interface PluginContext {
  pluginId: string;
  facts: string[];
  /** Plugin hint that the user is in a high-focus situation (e.g. combat). */
  focus?: boolean;
}

export interface PluginEvent {
  pluginId: string;
  kind: string;
  description: string;
  /** 0..1 */
  importance: number;
  at: number;
  /** Mark events that indicate the user needs to concentrate (combat etc). */
  focus?: boolean;
}

/** Structured LLM output (design doc §8.2). */
export interface CompanionResponse {
  speak: boolean;
  text: string;
  temperature: Temperature;
  emotion: Emotion;
  intensity: number;
  gaze: Gaze;
  gesture: Gesture;
  memory_write: string[];
  topic_action: TopicAction;
  needs_vision: boolean;
  needs_tool: { name: string; args: unknown } | null;
}

/** The subset the avatar renderer receives. */
export interface PerformanceCue {
  emotion: Emotion;
  intensity: number;
  gaze: Gaze;
  gesture: Gesture;
}

export interface Turn {
  role: 'user' | 'navi';
  text: string;
  at: number;
  interrupted?: boolean;
}
