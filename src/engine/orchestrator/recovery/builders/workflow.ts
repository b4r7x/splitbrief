import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { UserEditConflict } from '../../../events/workflow-events.js';
import { uniqueSortedIds } from '../../../../utils/collections.js';
import type { RecoveryBuilderBase } from './issue.js';
import { compactFacts, createRecoveryIssue } from './issue.js';
import { userEditActionToRecoveryAction } from '../../../../core/recovery/user-edit-actions.js';
import { chooseRecommended, chooseUserEditRecommendation, orderedActions } from './actions.js';
import { fileConflictDetails } from './details.js';

export interface UserEditConflictRecoveryOptions extends RecoveryBuilderBase {
  conflict: UserEditConflict;
  currentTask?: Task | undefined;
  phase?: Phase | undefined;
}

export interface ApprovalPromotionConflictRecoveryOptions extends RecoveryBuilderBase {
  conflict: UserEditConflict;
  currentTask?: Task | undefined;
  phase?: Phase | undefined;
}

export function buildUserEditConflictRecoveryIssue(
  opts: UserEditConflictRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const hasCurrentTask =
    opts.currentTask !== undefined || opts.conflict.currentTaskId !== undefined;
  const actions = orderedActions(
    opts.conflict.availableActions
      .map(userEditActionToRecoveryAction)
      .filter(
        (action) =>
          (hasCurrentTask || action !== 'skip-current-task') &&
          (opts.conflict.safeToContinue || action !== 'continue'),
      ),
  );
  const recommendedAction = chooseUserEditRecommendation(opts.conflict, actions);
  const affectedTaskIds = uniqueSortedIds([
    ...opts.conflict.affectedTaskIds,
    ...(opts.conflict.currentTaskId ? [opts.conflict.currentTaskId] : []),
  ]);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'user-edit-conflict',
    phase,
    task: opts.currentTask,
    files: opts.conflict.files,
    affectedTaskIds,
    message: userEditMessage(opts.conflict, opts.currentTask),
    details: [
      `Conflict kind: ${opts.conflict.kind}`,
      `Safe to continue: ${opts.conflict.safeToContinue ? 'yes' : 'no'}`,
      ...fileConflictDetails(opts.conflict),
    ],
    facts: compactFacts({
      conflictKind: opts.conflict.kind,
      safeToContinue: opts.conflict.safeToContinue,
    }),
    availableActions: actions,
    recommendedAction,
    createdAt: opts.createdAt,
  });
}

export function buildApprovalPromotionConflictRecoveryIssue(
  opts: ApprovalPromotionConflictRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const hasCurrentTask =
    opts.currentTask !== undefined || opts.conflict.currentTaskId !== undefined;
  const actions = orderedActions(
    opts.conflict.availableActions
      .map(userEditActionToRecoveryAction)
      .filter(
        (action) => action !== 'continue' && (hasCurrentTask || action !== 'skip-current-task'),
      ),
  );
  const affectedTaskIds = uniqueSortedIds([
    ...opts.conflict.affectedTaskIds,
    ...(opts.conflict.currentTaskId ? [opts.conflict.currentTaskId] : []),
  ]);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'approval-promotion-conflict',
    phase,
    task: opts.currentTask,
    files: opts.conflict.files,
    affectedTaskIds,
    message: approvalPromotionMessage(opts.conflict, opts.currentTask),
    details: [
      'Approved output cannot be promoted because files changed during approval.',
      ...fileConflictDetails(opts.conflict),
    ],
    facts: compactFacts({
      conflictKind: opts.conflict.kind,
      safeToContinue: false,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['pause-run']),
    createdAt: opts.createdAt,
  });
}

function userEditMessage(conflict: UserEditConflict, currentTask: Task | undefined): string {
  if (currentTask) return `User edits conflict with ${currentTask.id}`;
  if (conflict.currentTaskId) return `User edits conflict with ${conflict.currentTaskId}`;
  return 'User edits require a recovery decision';
}

function approvalPromotionMessage(
  conflict: UserEditConflict,
  currentTask: Task | undefined,
): string {
  if (currentTask) return `Approval promotion blocked for ${currentTask.id}`;
  if (conflict.currentTaskId) return `Approval promotion blocked for ${conflict.currentTaskId}`;
  return 'Approval promotion blocked by changed files';
}
