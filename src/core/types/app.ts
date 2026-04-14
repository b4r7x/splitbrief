import type { z } from 'zod';
import type { Phase, TaskStatus, WorkflowState } from './workflow.js';
import type { Summary } from './summary.js';
import type { WorkflowMode } from './config.js';
import type { SessionSchema } from './schemas/session.js';

export type Screen = 'home' | 'workflow' | 'summary' | 'setup';

export const ALL_SCREENS: readonly Screen[] = ['home', 'workflow', 'summary', 'setup'];

export type InputMode = 'normal' | 'review' | 'question';

export type RouteData =
  | { screen: 'home' }
  | { screen: 'workflow'; feature: string; resumeState?: WorkflowState | undefined; sessionId?: string | undefined }
  | { screen: 'summary'; summary: Summary }
  | { screen: 'setup'; onComplete?: 'home' | 'workflow' | undefined; feature?: string | undefined };

export type Session = z.infer<typeof SessionSchema>;

export type OverlayType = 'none' | 'help' | 'command-palette' | 'skills' | 'settings' | 'mode-selector' | 'planner-picker' | 'implementer-picker' | 'sessions';

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: 'global' | 'project';
}

interface SlashCommandBase {
  name: string;
  aliases?: string[];
  label?: string;
  description: string;
  shortcut?: string | null;
  validScreens: readonly Screen[];
  phaseGuard?: ((phase: Phase) => boolean) | undefined;
}

export type SlashCommandDef =
  | (SlashCommandBase & { kind: 'noarg'; handler: () => void })
  | (SlashCommandBase & { kind: 'arg'; handler: (args: string | undefined) => void });

export interface CommandContext {
  openOverlay: (type: OverlayType, focus?: string) => void;
  navigate: (screen: Screen) => void;
  quit: () => void;
  setWorkflowMode: (mode: WorkflowMode) => boolean;
  setFeedbackMessage: (msg: string) => void;
  setFeedbackError: (msg: string) => void;
  refreshDetection: () => Promise<void>;
  getCurrentPhase: () => Phase;
  requestRewind: (target: 'spec' | 'plan', comment?: string) => boolean;
  requestTaskRedo: (taskId: string) => boolean;
  getQueueDepth: () => number;
  clearQueue: () => number;
}

export interface CommandPaletteItem {
  label: string;
  description: string;
  shortcut: string | null;
  action: () => void;
  availableOn: readonly Screen[];
}

export interface SidebarTask {
  id: string;
  title: string;
  status: TaskStatus;
}
