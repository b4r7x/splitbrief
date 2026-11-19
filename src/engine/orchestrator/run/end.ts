import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { recordInterruptedCalls } from '../../calls/interrupted.js';
import type { EventBus } from '../../events/types.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../events/workflow-cancel.js';
import { publishRecoveryActionSelected, publishRecoveryResolved } from '../publish/recovery.js';
import { finalizeRunAtRest } from '../session-lifecycle/finalize.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { closeRunIfOpen } from './close.js';
import { withAtRestSession } from './liveness.js';

/**
 * A user stop stopped work only when it left the run open or closed it as ended. End run on a
 * ready run is its Discard, and a complete run had nothing left to stop.
 */
export function userStopStoppedWork(state: WorkflowState): boolean {
  const status = deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false });
  return status.kind === 'open' || (status.kind === 'closed' && status.as === 'ended');
}

export async function endRun(
  scope: SessionRef & { bus: EventBus },
  state: WorkflowState,
  atRestFrom?: number,
): Promise<{ state: WorkflowState; closedNow: boolean }> {
  const latest = rebaseOnPersistedWorkflowState(scope, state);
  const issue = latest.pendingRecovery;
  const closure = await closeRunIfOpen(scope, latest);
  if (closure.closedNow) {
    if (issue !== undefined) {
      publishRecoveryActionSelected({
        bus: scope.bus,
        phase: latest.phase,
        issue,
        action: 'end-run',
      });
      publishRecoveryResolved({
        bus: scope.bus,
        phase: closure.state.phase,
        issue,
        action: 'end-run',
        outcome: 'aborted',
      });
    }
    if (userStopStoppedWork(closure.state)) {
      scope.bus.publish({
        type: 'workflow_cancelled',
        ts: Date.now(),
        phase: closure.state.phase,
        reason: WORKFLOW_CANCEL_REASON_USER,
        ...(atRestFrom !== undefined && { atRestFrom }),
      });
    }
  }
  return closure;
}

export async function endRunAtRest(
  scope: SessionRef & { bus: EventBus },
  state: WorkflowState,
): Promise<{ state: WorkflowState; closedNow: boolean }> {
  const atRestFrom = Date.now();
  return withAtRestSession(scope, async () => {
    const current = rebaseOnPersistedWorkflowState(scope, state);
    await recordInterruptedCalls(scope, current);
    const closure = await endRun(scope, current, atRestFrom);
    if (closure.closedNow) finalizeRunAtRest({ ref: scope, state: closure.state });
    return closure;
  });
}
