import type { EngineEvent } from '../../engine/events/types.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { StateAuthorityReceipt } from '../../core/state/types.js';
import type { RewindTarget } from '../../core/state/build-rewind-action.js';
import { buildRewindAction } from '../../core/state/build-rewind-action.js';
import { transitionAndSave } from '../../engine/orchestrator/state-ops.js';
import { refreshWorkflowAuthority } from '../../engine/orchestrator/run/authority.js';
import { appendProtectedEngineEvent } from '../../core/sessions/log-writer.js';
import { RewindEventSchema } from '../../core/state/rewind-event.js';
import { WORKFLOW_REWIND_ABORT_REASON } from '../../engine/orchestrator/run/rewind-authority.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { type ResumeHydration, resumeFailureMessage } from './resume-hydration.js';

export interface PendingRewind {
  prepared: PreparedExecution;
  event: EngineEvent;
  feedback: string | undefined;
}

interface RewindHandlerDeps {
  prepared: PreparedExecution;
  controller: AbortController;
  hydrate: (ref: SessionRef) => ResumeHydration;
  resetMode: () => void;
  setAuthority: (receipt: StateAuthorityReceipt) => void;
  setPendingRewind: (pending: PendingRewind) => void;
  onRewound: (next: WorkflowState) => void;
}

export function buildRewindHandler({
  prepared,
  controller,
  hydrate,
  resetMode,
  setAuthority,
  setPendingRewind,
  onRewound,
}: RewindHandlerDeps): (request: RewindTarget) => void {
  return (request) => {
    resetMode();
    const ref = prepared.session.ref;
    const hydrated = hydrate(ref);
    if (hydrated.kind === 'missing') return;
    if (hydrated.kind === 'invalid') {
      feedbackStore.setError(resumeFailureMessage(hydrated));
      return;
    }
    const current = hydrated.state;

    const { action, persistedAction, event } = buildRewindAction({
      request,
      ref,
      state: current,
      persistEvent: false,
      persistTranscript: prepared.config.workflow.persistTranscript,
    });
    let next: WorkflowState;
    try {
      next = transitionAndSave(ref, current, persistedAction, {
        authority: hydrated.authority,
        expectedRevision: current.stateRevision,
      });
      setAuthority(refreshWorkflowAuthority(ref, hydrated.authority, next));
    } catch (cause) {
      feedbackStore.setError(toErrorMessage(cause));
      return;
    }
    appendProtectedEngineEvent(ref, event, RewindEventSchema);
    setPendingRewind({
      prepared,
      event,
      feedback:
        action.type === 'REWIND_TO_SPEC' || action.type === 'REWIND_TO_PLAN'
          ? action.comment
          : undefined,
    });
    controller.abort(WORKFLOW_REWIND_ABORT_REASON);
    onRewound(next);
  };
}
