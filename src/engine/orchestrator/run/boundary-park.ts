import { fixCyclesOf, type WorkflowState } from '../../../core/schemas/workflow.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import type { BoundaryPark, WorkflowContext } from '../types.js';
import { recordSteer } from '../continuation.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from '../state-ops.js';
import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import { afterLastBrief } from '../../../core/sessions/run-status.js';

/**
 * The run held in place at a brief or review boundary. The state records the step the run
 * will start next, so leaving the screen persists as a boundary park and the
 * run picks up there; `/resume` settles the promise and the loop carries on.
 */
export async function parkAtBoundary(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  park: BoundaryPark;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ state: WorkflowState; continued: boolean }> {
  const { wctx, setTrackedState } = args;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const onContinuationNeeded = wctx.callbacks.onContinuationNeeded;
  const nextTask = args.state.tasks[args.state.currentTaskIndex];
  const step: StepRef =
    nextTask === undefined
      ? afterLastBrief(
          args.state,
          resolveReviewCadence(wctx.config) === 'none',
          fixCyclesOf(args.state).used,
        )
      : { kind: 'brief', taskId: nextTask.id, attempt: 0 };

  let state = transitionAndSave(ref, args.state, {
    type: 'INTERRUPT_STEP',
    step,
    source: 'user',
    cut: 'boundary',
  });
  setTrackedState(state);
  wctx.bus.publish({
    type: 'turn_interrupted',
    ts: Date.now(),
    phase: state.phase,
    source: 'user',
    at: 'boundary',
    step,
    ...(args.park === 'seat-change' && { cause: 'seat-change' as const }),
  });

  // No prompt surface means nothing can continue this run in place; the park is
  // recorded and the run ends, resumable at the brief it stopped before.
  if (onContinuationNeeded === undefined) return { state, continued: false };

  const steer = await onContinuationNeeded('', 'boundary', []);
  if (wctx.signal?.aborted) return { state, continued: false };
  const resumedAt = wctx.sinks.getContinuationResumedAt?.() ?? Date.now();
  state = transitionAndSave(ref, state, { type: 'RESUME_STEP' });
  setTrackedState(state);
  recordSteer({ ...ref, bus: wctx.bus }, state.phase, steer);
  state = rebaseOnPersistedWorkflowState(ref, state);
  setTrackedState(state);
  wctx.bus.publish({
    type: 'workflow_resumed',
    ts: Date.now(),
    phase: state.phase,
    inProcess: true,
    resumedAt,
  });
  wctx.continuation?.hold(step, steer.text.trim() === '' ? undefined : steer);
  return { state, continued: true };
}

/**
 * Takes a saved seat before a review pass or a fix cycle starts. With no seat change waiting it
 * does nothing. With one, the run parks for it, and `stopped` says that the park ended this entry.
 */
export async function takeSeatChangeAtBoundary(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ state: WorkflowState; stopped: boolean }> {
  if (args.wctx.sinks.seatChangeWaits?.() !== true) return { state: args.state, stopped: false };
  const parked = await parkAtBoundary({ ...args, park: 'seat-change' });
  return { state: parked.state, stopped: !parked.continued };
}
