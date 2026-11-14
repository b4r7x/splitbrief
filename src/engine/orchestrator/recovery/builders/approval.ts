import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import { haltActions, chooseRecommended } from './actions.js';
import { taskFiles, attemptDetails } from './details.js';
import {
  type RecoveryBuilderBase,
  type TaskRecoveryContext,
  createRecoveryIssue,
  compactFacts,
} from './issue.js';

export interface ApprovalDeniedRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  deniedFiles?: readonly string[] | undefined;
  denialReason?: string | undefined;
  tool?: string | undefined;
}

/** The operator refused the brief's writes; the run waits rather than retrying into the same gate. */
export function buildApprovalDeniedRecoveryIssue(
  opts: ApprovalDeniedRecoveryOptions,
): RecoveryIssue {
  const denied = opts.deniedFiles ?? [];
  const actions = haltActions('approval-denied', [
    'retry-same-worker',
    'skip-current-task',
    'end-run',
  ]);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'approval-denied',
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: denied.length > 0 ? [...denied] : taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} was denied at the approval gate`,
    details: [
      opts.denialReason !== undefined ? `Denied: ${opts.denialReason}` : undefined,
      denied.length > 0 ? `Blocked files: ${denied.join(', ')}` : undefined,
      ...attemptDetails(opts.attempts),
    ].filter((detail): detail is string => detail !== undefined),
    facts: compactFacts({ tool: opts.tool, denialReason: opts.denialReason }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

export interface SnapshotFailedRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  detail: string;
}

/**
 * Without a task-start snapshot the run cannot tell the implementer's writes
 * from the operator's, so drift and revert both stop working. The run halts
 * before the brief instead of running blind.
 */
export function buildSnapshotFailedRecoveryIssue(
  opts: SnapshotFailedRecoveryOptions,
): RecoveryIssue {
  const actions = haltActions('snapshot-failed', ['retry-same-worker', 'end-run']);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'snapshot-failed',
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} could not capture its task-start snapshot`,
    details: [opts.detail, 'Scope and revert cannot be enforced without the snapshot.'],
    availableActions: actions,
    recommendedAction: 'retry-same-worker',
    createdAt: opts.createdAt,
  });
}
