import type { RecoveryAction, RecoveryReason } from '../enums.js';
import { assertNever } from '../../../utils/type-guards.js';

/**
 * A final review that reported blocking findings offers the run's two exits and
 * `revise`, which sends the review's findings and the operator's correction back
 * through one more repair cycle. A review that reached no verdict at all — the
 * seat was handed an incomplete packet, or the call never landed — can also be
 * re-issued once the seat is corrected, so `retry-same-worker` is legal here; the
 * builder offers it only for that non-verdict case.
 */
const REVIEW_FAILED_ACTIONS = [
  'retry-same-worker',
  'revise',
  'accept-as-is',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
const TASK_RECOVERY_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'skip-current-task',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
/**
 * A seat that cannot run at all — out of quota, signed out, or overrunning its
 * deadline twice — can also move to another detected tool. `switch-seat` is
 * legal for those halts alone: every other one is about the task, not the seat.
 */
const SEAT_BLOCKED_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'switch-seat',
  'skip-current-task',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
/**
 * A planner call that failed has no task to skip and no bigger profile to route
 * to: the seat either runs again or the run stops on it.
 */
const PLANNER_CALL_ACTIONS = [
  'retry-same-worker',
  'switch-seat',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
const PLANNER_OUTPUT_ACTIONS = [
  'retry-same-worker',
  'revise',
  'end-run',
] as const satisfies readonly RecoveryAction[];
const REVISE_OR_END_ACTIONS = ['revise', 'end-run'] as const satisfies readonly RecoveryAction[];
const CONSTITUTION_ACTIONS = [
  'revise-spec',
  'end-run',
] as const satisfies readonly RecoveryAction[];
const CONTEXT_OVERFLOW_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
const CONFLICT_RECOVERY_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'planner-split-rebase',
  'continue',
  'skip-current-task',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
const SCOPE_RECOVERY_ACTIONS = [
  'retry-same-worker',
  'skip-current-task',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
const RECIPE_INVALID_ACTIONS = [
  'retry-same-worker',
  'switch-seat',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
/**
 * An implementer that reached outside its isolation directory is stopped at
 * once, and a checkout whose git state changed under a call halts the brief the
 * same way. The brief itself may be sound, so it can run again, on this tool or
 * another one, or be skipped; nothing it wrote in the isolation directory was
 * promoted.
 */
const LEFT_ISOLATION_ACTIONS = [
  'retry-same-worker',
  'switch-seat',
  'skip-current-task',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
const SNAPSHOT_FAILED_ACTIONS = [
  'retry-same-worker',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
/**
 * A lineage out of consults or attempts, or a run out of planner calls, can
 * continue once the operator grants more, skip the brief it stopped, or end.
 * The continue carries the operator's note into the grant.
 */
const CONSULT_BOUND_ACTIONS = [
  'continue',
  'skip-current-task',
  'end-run',
] as const satisfies readonly RecoveryAction[];
const DEPENDENCY_BLOCKED_ACTIONS = [
  'skip-current-task',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
/** Apply re-runs after the owner resolves workspace files, pauses or ends; no task to skip or seat to change. */
const APPLY_ACTIONS = [
  'retry-same-worker',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];
const APPLY_PARTIAL_ACTIONS = [
  'retry-same-worker',
  'restore-backup',
  'pause-run',
  'end-run',
] as const satisfies readonly RecoveryAction[];

function copyActions(actions: readonly RecoveryAction[]): RecoveryAction[] {
  return [...actions];
}

export function allowedActionsForReason(reason: RecoveryReason): RecoveryAction[] {
  switch (reason) {
    case 'apply-conflict':
      return copyActions(APPLY_ACTIONS);
    case 'apply-partial':
      return copyActions(APPLY_PARTIAL_ACTIONS);
    case 'user-edit-conflict':
    case 'approval-promotion-conflict':
      return copyActions(CONFLICT_RECOVERY_ACTIONS);
    case 'implementation-error':
    case 'validation-failed':
    case 'retry-exhausted':
      return copyActions(TASK_RECOVERY_ACTIONS);
    case 'consult-bound-spent':
    case 'planner-calls-spent':
      return copyActions(CONSULT_BOUND_ACTIONS);
    case 'runner-unauthenticated':
    case 'runner-usage-limit':
      return copyActions(SEAT_BLOCKED_ACTIONS);
    case 'context-overflow':
      return copyActions(CONTEXT_OVERFLOW_ACTIONS);
    case 'dependency-blocked':
      return copyActions(DEPENDENCY_BLOCKED_ACTIONS);
    case 'scope-violation':
    case 'approval-denied':
      return copyActions(SCOPE_RECOVERY_ACTIONS);
    case 'implementer-recipe-invalid':
      return copyActions(RECIPE_INVALID_ACTIONS);
    case 'implementer-left-isolation':
    case 'checkout-changed':
      return copyActions(LEFT_ISOLATION_ACTIONS);
    case 'runner-timeout-repeated':
      return copyActions(SEAT_BLOCKED_ACTIONS);
    case 'snapshot-failed':
      return copyActions(SNAPSHOT_FAILED_ACTIONS);
    case 'review-failed':
      return copyActions(REVIEW_FAILED_ACTIONS);
    case 'planner-call-failed':
    case 'seat-protocol-error':
      return copyActions(PLANNER_CALL_ACTIONS);
    case 'planner-returned-no-briefs':
    case 'brief-quality-unrepaired':
    case 'plan-questions-exhausted':
    case 'plan-checks-failed':
      return copyActions(PLANNER_OUTPUT_ACTIONS);
    case 'brief-review-no-progress':
      return copyActions(REVISE_OR_END_ACTIONS);
    case 'constitution-check-failed':
      return copyActions(CONSTITUTION_ACTIONS);
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
