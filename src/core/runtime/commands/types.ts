import { assertNever } from '../../../utils/type-guards.js';
import type { Phase } from '../../schemas/enums.js';
import type { WorkflowMode } from '../../schemas/enums.js';
import { CREW_SEAT_IDS } from '../../crew/identity.js';
import type { OverlayType, Screen } from '../../navigation/types.js';
import type { HandoffTarget } from '../../handoff/targets.js';
import type { ApprovalGrant } from '../../schemas/approval-store.js';
import type { StructuredSummary } from '../../schemas/compaction.js';
import type { CopyOutcome } from '../../../lib/clipboard/clipboard.js';
import type { ResolveAttachmentReason } from '../../attachments/resolve.js';

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

export type ToggleLatestDiffResult =
  | { status: 'toggled'; expanded: boolean }
  | { status: 'unavailable'; message: string };

export type ToggleSidebarResult =
  | { status: 'toggled'; visible: boolean }
  | { status: 'unavailable'; message: string };

export type RuntimeConfigSaveResult =
  | Readonly<{ kind: 'saved'; ok: true }>
  | Readonly<{ kind: 'conflict'; ok: false; errorMessage?: string | undefined }>
  | Readonly<{ kind: 'durability-uncertain'; ok: false; errorMessage?: string | undefined }>
  | Readonly<{ kind: 'failure'; ok: false; errorMessage?: string | undefined }>;

export type DiscoveryRefreshLaneOutcome =
  | 'cached'
  | 'fresh'
  | 'not-modified'
  | 'stale'
  | 'failed'
  | 'not-run';

export type DiscoveryRefreshNotRunReason = 'offline' | 'cancelled' | 'superseded' | 'uninitialized';

export interface DiscoveryRefreshLaneSummary {
  readonly outcome: DiscoveryRefreshLaneOutcome;
  readonly reason?: DiscoveryRefreshNotRunReason | undefined;
}

export type DiscoveryRefreshStatus =
  | 'fresh'
  | 'partial'
  | 'stale'
  | 'failed'
  | 'not-run'
  | 'uninitialized'
  | 'superseded';

export interface DiscoveryRefreshSummary {
  readonly status: DiscoveryRefreshStatus;
  readonly published: boolean;
  readonly lanes: Readonly<{
    readiness: DiscoveryRefreshLaneSummary;
    modelsDev: DiscoveryRefreshLaneSummary;
    cliModels: DiscoveryRefreshLaneSummary;
  }>;
}

export function formatDiscoveryRefreshFeedback(
  input: Readonly<{ subject: string; summary: DiscoveryRefreshSummary }>,
): { message: string; isError: boolean } {
  switch (input.summary.status) {
    case 'fresh':
      return { message: `${input.subject} refreshed`, isError: false };
    case 'partial':
      return { message: `${input.subject} refresh completed with partial results`, isError: true };
    case 'stale':
      return { message: `${input.subject} refresh kept stale results`, isError: true };
    case 'failed':
      return { message: `${input.subject} refresh failed`, isError: true };
    case 'not-run':
      return { message: `${input.subject} refresh was not run`, isError: true };
    case 'uninitialized':
      return { message: `${input.subject} refresh is not initialized`, isError: true };
    case 'superseded':
      return { message: `${input.subject} refresh was superseded`, isError: true };
    default:
      return assertNever(input.summary.status);
  }
}

export const COMMAND_CATEGORIES = ['navigate', 'crew', 'workflow', 'view', 'io'] as const;

export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export const COMMAND_CATEGORY_LABELS: Readonly<Record<CommandCategory, string>> = {
  navigate: 'Navigate',
  crew: 'Crew',
  workflow: 'Workflow',
  view: 'View',
  io: 'Input & output',
};

export const RUN_ACTIONS = ['accept', 'reject'] as const;

export const QUEUE_ACTIONS = ['show', 'clear'] as const;

export const APPROVAL_ACTIONS = ['list', 'clear'] as const;

export const IMAGE_ACTIONS = ['list', 'remove'] as const;

export const CREW_COMMAND_SEATS = CREW_SEAT_IDS;

/** Deleted names keep pointing at their replacement for one release. */
export const REMOVED_COMMANDS: Readonly<Record<string, string>> = {
  '/attach': 'images are attached with /image <path>',
  '/detach': 'images are removed with /image remove <index|id>',
  '/effort': 'effort lives on the seat: /crew plan',
  '/repomap': 'the repo map rebuilds itself on each planning run, with no manual step',
  '/resume': 'a paused workflow resumes from its approval prompt',
};

export type AttachImageResult =
  | { ok: true; path: string }
  | { ok: false; reason: ResolveAttachmentReason | 'no-vision' };

export interface SkillCommandOption {
  id: string;
  name: string;
  description: string;
}

export type SkillToggleResult =
  | { status: 'selected'; name: string }
  | { status: 'deselected'; name: string }
  | { status: 'unknown' }
  | { status: 'unavailable'; message: string };

export interface CommandGuardContext {
  phase: Phase;
  attached: boolean;
  plannerSupportsImages: boolean;
}

type CommandArgSpec =
  | {
      kind: 'closed';
      options: readonly string[];
      optionDescriptions?: Readonly<Record<string, string>>;
      /** Display grammar for option sets too large to spell out in a palette or help row. */
      hint?: string;
      optional?: true;
    }
  | { kind: 'free'; hint: string };

interface RuntimeCommandBase {
  name: string;
  aliases?: readonly { name: string; args?: string }[];
  label?: string;
  description: string;
  shortcut?: string | null;
  validScreens: readonly Screen[];
  category: CommandCategory;
  hidden?: true;
  /** A returned string is the reason: it blocks the command and hides its row. */
  guard?: (ctx: CommandGuardContext) => string | undefined;
}

export type RuntimeCommandDef =
  | (RuntimeCommandBase & { kind: 'noarg'; handler: () => CommandHandlerResult })
  | (RuntimeCommandBase & {
      kind: 'arg';
      args: CommandArgSpec;
      handler: (args: string | undefined) => CommandHandlerResult;
    });

export interface RuntimeCommandContext {
  isAttached?: boolean;
  openOverlay: (type: OverlayType, focus?: string) => void;
  navigate: (to: 'home') => void;
  quit: () => void;
  setWorkflowMode: (mode: WorkflowMode) => Promise<RuntimeConfigSaveResult>;
  setFeedbackMessage: (msg: string) => void;
  setFeedbackError: (msg: string) => void;
  refreshDetection: () => Promise<DiscoveryRefreshSummary>;
  refreshProjectFiles: () => void;
  listSkills: () => readonly SkillCommandOption[];
  toggleSkill: (id: string) => SkillToggleResult;
  refreshSkills: () => void;
  getCurrentPhase: () => Phase;
  requestRewind: (target: 'spec' | 'plan', comment?: string) => boolean;
  requestTaskRedo: (taskId: string) => boolean;
  getQueueDepth: () => number;
  clearQueue: () => QueueClearCommandResult | Promise<QueueClearCommandResult>;
  attachImage: (input: string) => AttachImageResult;
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
  toggleLatestDiff: () => ToggleLatestDiffResult;
  toggleSidebar: () => ToggleSidebarResult;
  copyTarget: (target: CopyTarget) => Promise<CopyResult>;
}
