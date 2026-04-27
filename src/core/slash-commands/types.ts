import type { Phase } from '../schemas/enums.js';
import type { EffortLevel, WorkflowMode } from '../schemas/enums.js';
import type { OverlayType, Screen } from '../../stores/navigation/router.js';
import type { HandoffTarget } from '../../engine/handoff/types.js';
import type { ApprovalGrant } from '../schemas/approval-store.js';
import type { AcceptRunSnapshotResult, RejectRunSnapshotResult } from '../../engine/snapshots/run.js';

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
  setPlannerEffort: (effort: EffortLevel) => boolean;
  setFeedbackMessage: (msg: string) => void;
  setFeedbackError: (msg: string) => void;
  refreshDetection: () => Promise<void>;
  getCurrentPhase: () => Phase;
  requestRewind: (target: 'spec' | 'plan', comment?: string) => boolean;
  requestTaskRedo: (taskId: string) => boolean;
  getQueueDepth: () => number;
  clearQueue: () => number;
  rebuildRepomap: () => Promise<{ deleted: boolean; files: string[] }>;
  attachImage: (input: string) => { ok: true; path: string } | { ok: false; reason: string };
  detachImage: (idOrIndex: string) => boolean;
  listAttachments: () => Array<{ id: string; path: string }>;
  writeHandoff: (target: HandoffTarget, taskId?: string) => Promise<{ outputDir: string }>;
  listApprovals: () => ApprovalGrant[];
  clearApprovals: (scope?: 'session' | 'always' | 'all') => number;
  acceptRunSnapshot: () => Promise<AcceptRunSnapshotResult>;
  rejectRunSnapshot: () => Promise<RejectRunSnapshotResult>;
}

export interface CommandPaletteItem {
  label: string;
  description: string;
  shortcut: string | null;
  action: () => void;
  availableOn: readonly Screen[];
}
