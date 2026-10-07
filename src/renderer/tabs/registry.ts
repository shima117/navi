import type { ComponentType } from 'react';
import { AvatarTab } from './AvatarTab';
import { DiagnosticsTab } from './DiagnosticsTab';
import { FriendTab } from './FriendTab';
import { GamesTab } from './GamesTab';
import { MemoryTab } from './MemoryTab';
import { SettingsTab } from './SettingsTab';
import { SharedScreenTab } from './SharedScreenTab';

export interface TabDef {
  id: string;
  label: string;
  component: ComponentType<{ goTo: (id: string) => void }>;
}

/** Main-window tabs (§14), in display order. */
export const TABS: TabDef[] = [
  { id: 'friend', label: 'Friend', component: FriendTab },
  { id: 'screen', label: 'Shared Screen', component: SharedScreenTab },
  { id: 'games', label: 'Games', component: GamesTab },
  { id: 'memory', label: 'Memory', component: MemoryTab },
  { id: 'avatar', label: 'Avatar', component: AvatarTab },
  { id: 'settings', label: 'Settings', component: SettingsTab },
  { id: 'diagnostics', label: '診断', component: DiagnosticsTab },
];
