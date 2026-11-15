import type { Task } from '../../../core/schemas/task.js';
import type { TokenUsage, TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type { BlockedReport, RetryAttemptFailure } from '../escalation/types.js';
import type { WorkflowContext } from '../types.js';

/**
 * What the implementer calls of one brief share. The steps change it in place: the write gate and
 * the seat callbacks write it while a call runs, so a returned copy would be stale.
 */
export type ImplementerLoopState = {
  state: WorkflowState;
  /** The steer the brief recorded last: the same message is not recorded twice. */
  recordedCorrection: UserMessageInput | undefined;
  preApplyApprovalDenied: boolean;
  preApplyApprovedFiles: string[];
};

export type RetryAndRecordOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  state: WorkflowState;
  taskStartSnapshot: ChangedFilesSnapshot;
  initialChangedFiles?: string[] | undefined;
  /** How the first attempt ended, when it ended on a machine outcome. */
  initialFailure?: RetryAttemptFailure | undefined;
  /** The first attempt's blocked report, when it stopped asking for a decision. */
  initialBlocked?: BlockedReport | undefined;
  /** The user's answer to a change of what the first attempt reported. */
  initialAnswer?: string | undefined;
  /** The unfinished calls in a row before a consult that runs again, which its halt kept. */
  unfinishedCalls?: number | undefined;
  tokensBefore: TokenUsage;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
};

export type TaskFailureContext = Pick<
  RetryAndRecordOptions,
  'wctx' | 'task' | 'initialChangedFiles'
>;
