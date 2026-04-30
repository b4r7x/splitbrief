import type { Phase } from '../schemas/enums.js';
import type { EffortLevel, WorkflowMode } from '../schemas/enums.js';
import type { OverlayType, Screen } from '../navigation/types.js';
import type { HandoffTarget } from '../handoff/targets.js';
import type { ApprovalGrant } from '../schemas/approval-store.js';

type CommandHandlerResult = void | Promise<void>;

export interface AcceptRunSnapshotResult {
  snapshotId: string;
  isFirstSnapshot: boolean;
}

export type RejectRunSnapshotResult =
  | { status: 'empty' }
  | { status: 'accepted'; snapshotId: string }
  | {
    status: 'rejected';
    snapshotId: string;
    restoredPaths: string[];
    deletedPaths: string[];
    conflictedPaths: string[];
    missingSnapshotFiles: string[];
  };

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
  | (SlashCommandBase & { kind: 'noarg'; handler: () => CommandHandlerResult })
  | (SlashCommandBase & { kind: 'arg'; handler: (args: string | undefined) => CommandHandlerResult });

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
  getApprovalEnabled: () => boolean;
  setApprovalEnabled: (enabled: boolean) => void;
  acceptRunSnapshot: () => Promise<AcceptRunSnapshotResult>;
  rejectRunSnapshot: () => Promise<RejectRunSnapshotResult>;
}

export interface CommandPaletteItem {
  label: string;
  description: string;
  shortcut: string | null;
  action: () => CommandHandlerResult;
  availableOn: readonly Screen[];
}
