import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import {
  commitWorkflowState,
  MAX_STATE_CONFLICT_RETRIES,
  readWorkflowStateHead,
  rebaseOnPersistedWorkflowState,
  stateOpsError,
} from '../state-ops.js';

export function closeRunIfOpen(
  ref: SessionRef,
  state: WorkflowState,
): { state: WorkflowState; closedNow: boolean } {
  for (let attempt = 0; ; attempt += 1) {
    // A run stopped before it ever saved a state still closes: the close then
    // creates the head instead of failing the CAS against a file that is not there.
    const head = readWorkflowStateHead(ref);
    const latest = head === null ? state : rebaseOnPersistedWorkflowState(ref, state);
    if (deriveRunStatus({ state: latest, liveness: 'not-alive' }).kind === 'closed') {
      return { state: latest, closedNow: false };
    }

    const result = commitWorkflowState({
      ref,
      expected: head === null ? null : latest,
      next: transition(latest, { type: 'CLOSE_RUN' }),
    });
    if (result.kind === 'committed') return { state: result.state, closedNow: true };
    if (result.kind === 'durability-uncertain') throw stateOpsError.durabilityUncertain();
    if (attempt === MAX_STATE_CONFLICT_RETRIES) {
      throw stateOpsError.conflictExhausted({
        operation: 'transition',
        expectedRevision: latest.stateRevision ?? 0,
        observedRevision: readWorkflowStateHead(ref)?.state.stateRevision ?? null,
        attempts: attempt + 1,
        retryLimit: MAX_STATE_CONFLICT_RETRIES,
      });
    }
  }
}
