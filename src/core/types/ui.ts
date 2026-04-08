import type { TaskStatus } from './workflow.js';
import type { Summary } from './summary.js';
import type { WorkflowState } from './workflow.js';

export type Screen = 'home' | 'workflow' | 'summary' | 'setup';

export const ALL_SCREENS: Screen[] = ['home', 'workflow', 'summary', 'setup'];

export type InputMode = 'normal' | 'review' | 'question';

export type RouteData =
  | { screen: 'home' }
  | { screen: 'workflow'; feature: string; resumeState?: WorkflowState | undefined }
  | { screen: 'summary'; summary: Summary }
  | { screen: 'setup'; onComplete?: 'home' | 'workflow' | undefined; feature?: string | undefined };

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

export type OverlayType = 'none' | 'help' | 'command-palette' | 'skills' | 'settings' | 'mode-selector' | 'planner-picker' | 'implementer-picker';

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: 'global' | 'project';
}

export interface SlashCommandDef {
  name: string;
  aliases?: string[];
  label?: string;
  description: string;
  shortcut?: string | null;
  validScreens: Screen[];
  handler: (args?: string) => void;
}

export interface CommandContext {
  openOverlay: (type: OverlayType, focus?: string) => void;
  navigate: (screen: Screen) => void;
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
