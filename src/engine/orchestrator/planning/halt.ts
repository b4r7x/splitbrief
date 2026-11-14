import { PLAN_CORRECTION_GOES_AGAIN } from '../../../core/recovery/causes.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { raisePendingRecovery } from '../state-ops/halts.js';
import type { WorkflowPersistenceContext } from '../types.js';
import type { PlanningPhaseOptions } from './types.js';

/**
 * The words of the plan correction that stands on the run. Each new try of the planning session
 * sends them again until a plan compiles. Blank words are no correction.
 */
export function standingPlanCorrection(
  rewindPending: PlanningPhaseOptions['rewindPending'],
): string | undefined {
  const correction = rewindPending?.comment?.trim();
  return correction === '' ? undefined : correction;
}

/**
 * Raises a halt of the planning phase. While a plan correction stands on the run, the last detail
 * of the halt says that the correction goes again. A halt that offers End run only runs no step
 * again, so it carries no such detail.
 */
export function raisePlanningHalt(
  scope: WorkflowPersistenceContext,
  state: WorkflowState,
  issue: RecoveryIssue,
): WorkflowState {
  const goesAgain =
    standingPlanCorrection(state.rewindPending) !== undefined &&
    issue.availableActions.some((action) => action !== 'end-run');
  return raisePendingRecovery(
    scope,
    state,
    goesAgain ? { ...issue, details: [...issue.details, PLAN_CORRECTION_GOES_AGAIN] } : issue,
  );
}
