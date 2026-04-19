import type { Phase } from '../schemas/enums.js';
import type { WorkflowMode } from '../schemas/enums.js';
import type { OverlayType, Screen } from '../../stores/navigation/router.js';

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
  navigate: (to: 'home') => void;
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
