import type { Phase } from '../../schemas/enums.js';
import type { EffortLevel, WorkflowMode } from '../../schemas/enums.js';
import type { OverlayType, Screen } from '../../navigation/types.js';
import type { HandoffTarget } from '../../handoff/targets.js';
import type { ApprovalGrant } from '../../schemas/approval-store.js';
import type { StructuredSummary } from '../../schemas/compaction.js';
import type { CopyOutcome } from '../../../lib/clipboard/clipboard.js';

type CommandHandlerResult = void | Promise<void>;

export const COPY_TARGETS = ['message', 'brief', 'path', 'command', 'cost'] as const;

export type CopyTarget = (typeof COPY_TARGETS)[number];

export type CopyResult = CopyOutcome | 'empty';

export function formatCopyResult(result: CopyResult): string {
  if (result === 'empty') return 'Nothing to copy';
  if (result === 'unavailable') return 'Could not copy';
  // native/tmux are confirmed by a child process exiting 0; osc52 is an unacknowledged escape that
  // many terminals silently drop, so it must read as best-effort rather than a guaranteed copy.
  if (result === 'osc52')
    return 'Copy escape sent; verify your clipboard (some terminals block it)';
  return `Copied (${result})`;
}

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

export type CompactTranscriptResult =
  | { status: 'unsupported'; plannerName: string }
  | {
      status: 'compacted';
      summary: string;
      entriesRemoved: number;
      structured?: StructuredSummary | null;
    };

export type ExportSessionResult =
  | { status: 'ok'; path: string }
  | { status: 'error'; error: string };

export type QueueClearCommandResult =
  | { status: 'cleared'; count: number }
  | { status: 'unavailable'; message: string };

export const SCROLL_COMMAND_TARGETS = ['top', 'bottom', 'page-up', 'page-down'] as const;

export type ScrollCommandTarget = (typeof SCROLL_COMMAND_TARGETS)[number];

export type ScrollConversationResult =
  | { status: 'scrolled' }
  | { status: 'unavailable'; message: string };

export type ToggleLatestActivityBatchResult =
  | { status: 'toggled'; expanded: boolean }
  | { status: 'unavailable'; message: string };

export type ToggleSidebarResult =
  | { status: 'toggled'; visible: boolean }
  | { status: 'unavailable'; message: string };

interface RuntimeCommandBase {
  name: string;
  aliases?: string[];
  label?: string;
  description: string;
  shortcut?: string | null;
  validScreens: readonly Screen[];
  phaseGuard?: ((phase: Phase) => boolean) | undefined;
}

export type RuntimeCommandDef =
  | (RuntimeCommandBase & { kind: 'noarg'; handler: () => CommandHandlerResult })
  | (RuntimeCommandBase & {
      kind: 'arg';
      handler: (args: string | undefined) => CommandHandlerResult;
    });

export interface RuntimeCommandContext {
  isAttached?: boolean;
  openOverlay: (type: OverlayType, focus?: string) => void;
  navigate: (to: 'home') => void;
  quit: () => void;
  setWorkflowMode: (mode: WorkflowMode) => boolean;
  setPlannerEffort: (effort: EffortLevel) => boolean;
  setFeedbackMessage: (msg: string) => void;
  setFeedbackError: (msg: string) => void;
  refreshDetection: () => Promise<void>;
  refreshProjectFiles: () => void;
  getCurrentPhase: () => Phase;
  requestRewind: (target: 'spec' | 'plan', comment?: string) => boolean;
  requestTaskRedo: (taskId: string) => boolean;
  getQueueDepth: () => number;
  clearQueue: () => QueueClearCommandResult | Promise<QueueClearCommandResult>;
  rebuildRepomap: () => Promise<{ deleted: boolean; files: string[] }>;
  attachImage: (input: string) => { ok: true; path: string } | { ok: false; reason: string };
  detachImage: (idOrIndex: string) => boolean;
  listAttachments: () => Array<{ id: string; path: string }>;
  writeHandoff: (target: HandoffTarget, taskId?: string) => Promise<{ outputDir: string }>;
  listApprovals: () => ApprovalGrant[];
  clearApprovals: () => number;
  getApprovalEnabled: () => boolean;
  setApprovalEnabled: (enabled: boolean) => void;
  acceptRunSnapshot: () => Promise<AcceptRunSnapshotResult>;
  rejectRunSnapshot: () => Promise<RejectRunSnapshotResult>;
  compactTranscript: () => Promise<CompactTranscriptResult>;
  exportSession: () => Promise<ExportSessionResult>;
  scrollConversation: (target: ScrollCommandTarget) => ScrollConversationResult;
  toggleLatestActivityBatch: () => ToggleLatestActivityBatchResult;
  toggleSidebar: () => ToggleSidebarResult;
  copyTarget: (target: CopyTarget) => Promise<CopyResult>;
}

export interface CommandPaletteItem {
  label: string;
  description: string;
  shortcut: string | null;
  action: () => CommandHandlerResult;
  availableOn: readonly Screen[];
}
