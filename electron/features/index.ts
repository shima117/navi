import { avatarFeature } from './avatar';
import { captureFeature } from './capture';
import type { Feature } from './Feature';
import { friendFeature } from './friend';
import { memoryFeature } from './memory';
import { pluginsFeature } from './plugins';
import { settingsFeature } from './settings';
import { voiceFeature } from './voice';
import { resourceFeature } from './resource';
import { watchdogFeature } from './watchdog';
import { diagnosticsFeature } from './diagnostics';

/** Main-process features, set up in this order. */
export const FEATURES: Feature[] = [
  settingsFeature,
  captureFeature,
  friendFeature,
  memoryFeature,
  voiceFeature,
  avatarFeature,
  pluginsFeature,
  // PR-10 hardening. resource must come after settings: its settings listener overrides the manual mode.
  resourceFeature,
  watchdogFeature,
  diagnosticsFeature,
];
