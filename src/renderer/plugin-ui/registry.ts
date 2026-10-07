import type { ComponentType } from 'react';

/**
 * Plugin-specific panels shown under Games (§14: Tarkov's Task/MAP/Item UI
 * lives at Games > Escape from Tarkov). Keyed by GamePlugin.id.
 */
export const PLUGIN_UIS: Record<string, ComponentType> = {};
