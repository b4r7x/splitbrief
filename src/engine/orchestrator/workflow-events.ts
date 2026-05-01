import type { TaskId } from '../../core/schemas/task.js';
import type { RecoveryReason, TaskStatus } from '../../core/schemas/enums.js';
import type { TokenUsage, TaskTokenUsage } from '../../core/schemas/tokens.js';

export type UserEditConflictKind =
  | 'unrelated'
  | 'current-task-conflict'
  | 'future-task-stale-input'
  | 'dependency-file-conflict'
  | 'changed-during-approval-promotion';

export type UserEditConflictAction =
  | 'continue-unrelated'
  | 'regenerate-rebase'
  | 'pause'
  | 'skip-current-task'
  | 'abort-workflow';

export type UserEditConflictFile = {
  file: string;
  kind: UserEditConflictKind;
  affectedTaskIds: TaskId[];
};

export type UserEditConflict = {
  kind: UserEditConflictKind;
  files: string[];
  affectedTaskIds: TaskId[];
  currentTaskId?: TaskId;
  fileConflicts: UserEditConflictFile[];
  safeToContinue: boolean;
  availableActions: UserEditConflictAction[];
};

export type TaskContextFit = 'fits' | 'tight' | 'overflow';
export type CurrentCodeContextMode = 'none' | 'whole-file' | 'function-level' | 'truncated';

export type TaskReviewStatus = TaskStatus | 'recovery-required';
export type TaskReviewCommand = 'continue' | 'redo' | 'edit-notes' | 'revise-plan' | 'abort';
export type TaskReviewAction = 'continue' | 'redo-task' | 'revise-plan' | 'abort';

export interface TaskReviewValidation {
  passed: boolean | null;
  summary: string;
  stages: Array<{ stage: string; passed: boolean; errorSummary?: string | undefined }>;
}

export interface TaskReviewRequest {
  taskId: TaskId;
  taskTitle: string;
  status: TaskReviewStatus;
  filesTouched: string[];
  validation: TaskReviewValidation;
  evidence: {
    path?: string | undefined;
    summary: string;
    expected: string[];
    observed: string[];
  };
  cost: {
    tokenUsage: TokenUsage;
    taskTokens?: TaskTokenUsage | undefined;
    tool?: string | undefined;
    model?: string | undefined;
    implementerProfile?: string | undefined;
  };
  routing?: {
    selectedProfile?: string | undefined;
    fit: TaskContextFit;
    estimatedTokens: number;
    untruncatedEstimatedTokens: number;
    contextLength?: number | undefined;
    currentCodeTruncated: boolean;
    currentCodeContextMode: CurrentCodeContextMode;
    costPosture: string;
    reason: string;
  } | undefined;
  recovery?: {
    reason: RecoveryReason;
    message: string;
    availableActions: string[];
    recommendedAction: string;
  } | undefined;
  availableCommands: TaskReviewCommand[];
}

export interface TaskReviewResponse {
  action: TaskReviewAction;
  notes?: string | undefined;
}
