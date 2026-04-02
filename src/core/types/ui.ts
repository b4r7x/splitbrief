import type { TaskStatus } from './workflow.js';
import type { Summary } from './summary.js';
import type { WorkflowState } from './workflow.js';

export type Screen = 'home' | 'workflow' | 'summary';

export const ALL_SCREENS: Screen[] = ['home', 'workflow', 'summary'];

export type InputMode = 'normal' | 'review' | 'question';

export type RouteData =
  | { screen: 'home' }
  | { screen: 'workflow'; feature: string; resumeState?: WorkflowState }
  | { screen: 'summary'; summary: Summary };

export interface Session {
  id: string;
  feature: string;
  startedAt: number;
  completedAt: number | null;
  status: 'complete' | 'interrupted' | 'failed';
  summary: Summary | null;
  stateVersion: number;
  stateFile: string | null;
}

export type OverlayType = 'none' | 'help' | 'command-palette' | 'picker' | 'skills';

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: 'global' | 'project';
}

export interface SlashCommandDef {
  name: string;
  label?: string;
  description: string;
  shortcut?: string | null;
  validScreens: Screen[];
  handler: () => void;
}

export interface CommandContext {
  openOverlay: (type: OverlayType) => void;
  closeOverlay: () => void;
  showStatus: () => void;
  quit: () => void;
}

export interface CommandPaletteItem {
  label: string;
  description: string;
  shortcut: string | null;
  action: () => void;
  availableOn: Screen[];
}

export interface SidebarTask {
  id: string;
  title: string;
  status: TaskStatus;
}
