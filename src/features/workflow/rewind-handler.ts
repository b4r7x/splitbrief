import type { EngineEvent } from '../../engine/events/types.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskRedoRequest } from '../../core/state/build-rewind-action.js';
import { buildRewindAction } from '../../core/state/build-rewind-action.js';
import { transitionAndSave } from '../../engine/orchestrator/state-ops.js';
import { appendProtectedEngineEvent } from '../../core/sessions/log-writer.js';
import { RewindEventSchema } from '../../core/state/rewind-event.js';
import { WORKFLOW_REWIND_ABORT_REASON } from '../../core/phases.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { type ResumeHydration, resumeFailureMessage } from './resume-hydration.js';

export interface PendingRewind {
  prepared: PreparedExecution;
  event: EngineEvent;
}

interface RewindHandlerDeps {
  prepared: PreparedExecution;
  controller: AbortController;
  hydrate: (ref: SessionRef) => ResumeHydration;
  resetMode: () => void;
  setPendingRewind: (pending: PendingRewind) => void;
  onRewound: (next: WorkflowState) => void;
}

export function buildRewindHandler({
  prepared,
  controller,
  hydrate,
  resetMode,
  setPendingRewind,
  onRewound,
}: RewindHandlerDeps): (request: TaskRedoRequest) => void {
  return (request) => {
    resetMode();
    const ref = prepared.session.ref;
    const hydrated = hydrate(ref);
    if (hydrated.kind === 'missing') return;
    if (hydrated.kind === 'invalid') {
      feedbackStore.setError(resumeFailureMessage(hydrated));
      return;
    }
    const rewound = rewindSavedState(ref, request, hydrated.state);
    if (rewound === undefined) return;
    setPendingRewind({ prepared, event: rewound.event });
    controller.abort(WORKFLOW_REWIND_ABORT_REASON);
    onRewound(rewound.next);
  };
}

/**
 * Writes a rewind onto the saved state and the session log. A state that refuses it says why on
 * the feedback line and yields nothing.
 */
export function rewindSavedState(
  ref: SessionRef,
  request: TaskRedoRequest,
  current: WorkflowState,
): { next: WorkflowState; event: EngineEvent } | undefined {
  const { action, event } = buildRewindAction({ request, state: current });
  let next: WorkflowState;
  try {
    next = transitionAndSave(ref, current, action, {
      expectedRevision: current.stateRevision,
    });
  } catch (cause) {
    feedbackStore.setError(toErrorMessage(cause));
    return undefined;
  }
  appendProtectedEngineEvent(ref, event, RewindEventSchema);
  return { next, event };
}
