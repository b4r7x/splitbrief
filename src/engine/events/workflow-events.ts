import type { TaskId } from '../../core/schemas/task.js';
import type { UserEditConflictKind, UserEditConflictAction } from '../../core/schemas/enums.js';

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

export const TASK_REVIEW_COMMANDS = [
  'continue',
  'redo-task',
  'edit-notes',
  'revise-plan',
  'abort',
] as const;
