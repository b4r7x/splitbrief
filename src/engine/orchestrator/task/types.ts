import type { Task } from '../../../core/schemas/task.js';
import type { TokenUsage, TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { BlockedReport } from '../escalation/step.js';
import type { RetryAttemptFailure } from '../escalation/types.js';
import type { WorkflowContext } from '../types.js';

export type RetryAndRecordOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  state: WorkflowState;
  taskStartSnapshot?: ChangedFilesSnapshot;
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
