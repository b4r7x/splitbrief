import { haltOf } from '../../../core/recovery/halt.js';
import type { ConsultQuestion } from '../../../core/schemas/consult.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { resumeStep } from '../../../core/sessions/run/status.js';
import { keepUnsavedFailure } from '../../../core/state/resume-hydration.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { warnError } from '../../../lib/warn.js';
import type { EventBus } from '../../events/types.js';
import { publishRecoveryPrompted } from '../publish/recovery.js';
import { keptBriefFiles, runCodeDir } from '../kept-work.js';
import type { WorkflowPersistenceContext } from '../types.js';
import { commitWorkflowState } from './commit.js';
import { transitionAndSave } from './transition.js';

/**
 * Records why a run stopped, through the same CAS boundary as every other head
 * write. A conflict means a later writer already moved the head on; the failure
 * is reported through the bus either way, so the in-memory state is returned
 * rather than raising over a run that has already ended. A save that fails keeps
 * the failure in this process, so the run reads failed here; the disk cannot say so.
 */
export function recordLastFailure(
  ref: SessionRef,
  state: WorkflowState,
  failure: NonNullable<WorkflowState['lastFailure']>,
): WorkflowState {
  const next = { ...state, lastFailure: failure };
  try {
    const result = commitWorkflowState({ ref, expected: state, next });
    return result.kind === 'conflict' ? state : result.state;
  } catch (err) {
    warnError('Could not record why the run failed', err);
    keepUnsavedFailure(ref, state.stateRevision, failure);
    return next;
  }
}

export function raisePendingRecovery(
  scope: WorkflowPersistenceContext,
  state: WorkflowState,
  issue: RecoveryIssue,
  setTrackedState?: (s: WorkflowState) => void,
): WorkflowState {
  const next = transitionAndSave(scope, state, { type: 'SET_PENDING_RECOVERY', issue });
  publishRecoveryPrompted(
    { bus: scope.bus, phase: next.phase },
    scope.sessionId,
    issue,
    // Only a brief, the planning session or a seat review raises a halt: never a pass under REVIEW None.
    resumeStep(next, false),
    false,
  );
  setTrackedState?.(next);
  return next;
}

/**
 * Raises the halt of a brief. A *Seat down* halt also parks the brief's step: the brief keeps the
 * files its attempt left, and Switch, Try again and Try later continue on them. With `consult`, the
 * park holds the brief at its consult and the question it asked, so that consult runs again.
 */
export function raiseBriefHalt(
  scope: WorkflowPersistenceContext,
  state: WorkflowState,
  halt: { taskId: TaskId; issue: RecoveryIssue; consult?: ConsultQuestion | undefined },
  setTrackedState?: (s: WorkflowState) => void,
): WorkflowState {
  const parked =
    haltOf(halt.issue.reason) === 'seat-down'
      ? transitionAndSave(scope, state, {
          type: 'INTERRUPT_STEP',
          step: { kind: 'brief', taskId: halt.taskId, attempt: state.attempt },
          source: 'seat',
          cut: 'mid-step',
          ...(halt.consult !== undefined && { consult: halt.consult }),
        })
      : state;
  return raisePendingRecovery(scope, parked, halt.issue, setTrackedState);
}

/**
 * A stop the operator asked for parks the run at the step it picks up at, and the log holds the stop
 * as a row, not only the state. A run stopped before it had a bus still parks. A gate runs no call,
 * so a stop there cuts nothing. A cut brief records the files it wrote that are still changed, its
 * declared files first, read from the run's code as the stop leaves it. A park already recorded
 * stands: leaving a run parked in place is the same stop, so the state and the row stay the first
 * stop's.
 */
export async function parkStoppedRun(
  scope: SessionRef & { bus?: EventBus | undefined },
  state: WorkflowState,
  reviewNone: boolean,
): Promise<WorkflowState> {
  if (state.interruptedStep !== undefined) return state;
  const step = resumeStep(state, reviewNone);
  const cut = step.kind === 'gate' ? 'boundary' : 'mid-step';
  const kept = await keptBriefFiles(runCodeDir(scope.projectDir, state.workspace), state, step);
  const next = transitionAndSave(scope, state, {
    type: 'INTERRUPT_STEP',
    step,
    source: 'user',
    cut,
    kept,
  });
  scope.bus?.publish({
    type: 'turn_interrupted',
    ts: Date.now(),
    phase: next.phase,
    source: 'user',
    at: cut,
    step,
    ...(kept.length > 0 && { kept: [...kept] }),
  });
  return next;
}
