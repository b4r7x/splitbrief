import type { RecoveryAction, RecoveryReason } from '../enums.js';
import { assertNever } from '../../../utils/type-guards.js';

const PAUSE_OR_ABORT_ACTIONS = [
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const BUDGET_PAUSED_ACTIONS = [
  'continue',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const TASK_RECOVERY_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
/**
 * A quota-blocked seat can also move to another detected tool. The action is
 * legal for this reason alone: every other halt is about the task, not about
 * the seat being unable to run at all.
 */
const USAGE_LIMIT_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'switch-seat',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const CONTEXT_OVERFLOW_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const CONFLICT_RECOVERY_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'planner-split-rebase',
  'continue',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const SCOPE_RECOVERY_ACTIONS = [
  'retry-same-worker',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const RECIPE_INVALID_ACTIONS = [
  'retry-same-worker',
  'switch-seat',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const SNAPSHOT_FAILED_ACTIONS = [
  'retry-same-worker',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const DEPENDENCY_BLOCKED_ACTIONS = [
  'skip-current-task',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];

function copyActions(actions: readonly RecoveryAction[]): RecoveryAction[] {
  return [...actions];
}

export function allowedActionsForReason(reason: RecoveryReason): RecoveryAction[] {
  switch (reason) {
    case 'budget-exceeded':
      return copyActions(PAUSE_OR_ABORT_ACTIONS);
    case 'budget-paused':
      return copyActions(BUDGET_PAUSED_ACTIONS);
    case 'user-edit-conflict':
    case 'approval-promotion-conflict':
      return copyActions(CONFLICT_RECOVERY_ACTIONS);
    case 'implementation-error':
    case 'validation-failed':
    case 'retry-exhausted':
    case 'runner-unauthenticated':
      return copyActions(TASK_RECOVERY_ACTIONS);
    case 'runner-usage-limit':
      return copyActions(USAGE_LIMIT_ACTIONS);
    case 'context-overflow':
      return copyActions(CONTEXT_OVERFLOW_ACTIONS);
    case 'dependency-blocked':
      return copyActions(DEPENDENCY_BLOCKED_ACTIONS);
    case 'scope-violation':
    case 'approval-denied':
      return copyActions(SCOPE_RECOVERY_ACTIONS);
    case 'implementer-recipe-invalid':
      return copyActions(RECIPE_INVALID_ACTIONS);
    case 'implementer-timeout-repeated':
      return copyActions(USAGE_LIMIT_ACTIONS);
    case 'snapshot-failed':
      return copyActions(SNAPSHOT_FAILED_ACTIONS);
    case 'review-failed':
      return copyActions(PAUSE_OR_ABORT_ACTIONS);
    default:
      return assertNever(reason);
  }
}

type RecoveryActionSelection = {
  availableActions: RecoveryAction[];
  recommendedAction: RecoveryAction;
  selectedAction?: RecoveryAction | undefined;
};

type RecoveryReasonActions = {
  reason: RecoveryReason;
  availableActions: RecoveryAction[];
};

export function recommendedActionIsAvailable(issue: RecoveryActionSelection): boolean {
  return issue.availableActions.includes(issue.recommendedAction);
}

export function selectedActionIsAvailable(issue: RecoveryActionSelection): boolean {
  return (
    issue.selectedAction === undefined || issue.availableActions.includes(issue.selectedAction)
  );
}

export function actionsAreLegalForReason(issue: RecoveryReasonActions): boolean {
  const legal = allowedActionsForReason(issue.reason);
  return issue.availableActions.every((action) => legal.includes(action));
}
