import type { TaskId } from '../../core/schemas/task.js';
import type { TaskReviewRecovery } from '../../core/schemas/recovery.js';
import type {
  TaskStatus,
  UserEditConflictKind,
  UserEditConflictAction,
  TaskContextFit,
  CurrentCodeContextMode,
} from '../../core/schemas/enums.js';
import { UserEditConflictActionSchema } from '../../core/schemas/enums.js';
import type { TokenUsage, TaskTokenUsage } from '../../core/schemas/tokens.js';
import { includes } from '../../utils/type-guards.js';

export function isUserEditConflictAction(value: string): value is UserEditConflictAction {
  return UserEditConflictActionSchema.safeParse(value).success;
}

export type UserEditConflictFile = {
  file: string;
  kind: UserEditConflictKind;
  affectedTaskIds: TaskId[];
};

export type UserEditConflict = {
  kind: UserEditConflictKind;
  files: string[];
  affectedTaskIds: TaskId[];
  currentTaskId?: TaskId | undefined;
  fileConflicts: UserEditConflictFile[];
  safeToContinue: boolean;
  availableActions: UserEditConflictAction[];
};

export type TaskReviewStatus = TaskStatus | 'recovery-required';
export const TASK_REVIEW_COMMANDS = [
  'continue',
  'redo-task',
  'edit-notes',
  'revise-plan',
  'abort',
] as const;
export type TaskReviewCommand = (typeof TASK_REVIEW_COMMANDS)[number];
export type TaskReviewAction = Exclude<TaskReviewCommand, 'edit-notes'>;

export function isTaskReviewAction(value: unknown): value is TaskReviewAction {
  return includes(TASK_REVIEW_COMMANDS, value) && value !== 'edit-notes';
}

export type TaskReviewValidation = {
  passed: boolean | null;
  summary: string;
  stages: Array<{ stage: string; passed: boolean; errorSummary?: string | undefined }>;
};

export type TaskReviewRequest = {
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
  routing?:
    | {
        selectedProfile?: string | undefined;
        fit: TaskContextFit;
        estimatedTokens: number;
        untruncatedEstimatedTokens: number;
        contextLength?: number | undefined;
        currentCodeTruncated: boolean;
        currentCodeContextMode: CurrentCodeContextMode;
        costPosture: string;
        reason: string;
      }
    | undefined;
  recovery?: TaskReviewRecovery | undefined;
  availableCommands: TaskReviewCommand[];
};

export interface TaskReviewResponse {
  action: TaskReviewAction;
  notes?: string | undefined;
}
