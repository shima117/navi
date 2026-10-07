import { avatarFeature } from './avatar';
import { captureFeature } from './capture';
import type { Feature } from './Feature';
import { friendFeature } from './friend';
import { memoryFeature } from './memory';
import { pluginsFeature } from './plugins';
import { settingsFeature } from './settings';
import { voiceFeature } from './voice';

/** Main-process features, set up in this order. */
export const FEATURES: Feature[] = [
  settingsFeature,
  captureFeature,
  friendFeature,
  memoryFeature,
  voiceFeature,
  avatarFeature,
  pluginsFeature,
];
