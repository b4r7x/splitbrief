import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { resumeStep } from '../../../core/sessions/run/status.js';
import { createInitialState } from '../../../core/state/machine.js';
import { nowIso } from '../../../utils/format/time.js';
import type { WORKFLOW_CANCEL_REASON_USER } from '../../events/workflow-cancel.js';
import { parkStoppedRun, recordLastFailure } from '../state-ops/halts.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { userStopStoppedWork } from './end.js';
import type { RunTracker, ScopedRun } from './types.js';

export function trackedPhase(tracker: RunTracker, feature: string): WorkflowState['phase'] {
  return tracker.state?.phase ?? createInitialState(feature).phase;
}

// Why the run stopped belongs on the state, not in a status the exit path picks:
// the session record and every resume decision derive from it afterwards. The log names it too,
// so every surface that shows the run reads it from one fold.
export function recordFailure(
  run: ScopedRun,
  tracker: RunTracker,
  state: WorkflowState,
  message: string,
): WorkflowState {
  const step = resumeStep(state, resolveReviewCadence(run.config) === 'none');
  const next = recordLastFailure(run.ref, state, {
    step,
    message,
    at: nowIso(),
  });
  tracker.bus?.publish({
    type: 'run_failed',
    ts: Date.now(),
    phase: next.phase,
    step,
    message,
  });
  return next;
}

// Every other abort parks the step it cut, so the run reads `open · paused`.
// A crash that never reached this point still reads `interrupted`, which is
// the honest answer for a run that had no chance to say where it stopped.
export async function parkRun(
  run: ScopedRun,
  tracker: RunTracker,
  state: WorkflowState,
): Promise<WorkflowState> {
  const latest = rebaseOnPersistedWorkflowState(run.ref, state);
  if (
    latest.closed !== undefined ||
    latest.phase === 'complete' ||
    latest.interruptedStep !== undefined ||
    latest.pendingRecovery !== undefined
  ) {
    return latest;
  }
  return parkStoppedRun(
    { ...run.ref, bus: tracker.bus },
    latest,
    resolveReviewCadence(run.config) === 'none',
  );
}

export function publishWorkflowCancellation(
  tracker: RunTracker,
  feature: string,
  reason: typeof WORKFLOW_CANCEL_REASON_USER,
): void {
  const bus = tracker.bus;
  if (!bus) return;
  if (tracker.state !== undefined && !userStopStoppedWork(tracker.state)) return;
  bus.publish({
    type: 'workflow_cancelled',
    ts: Date.now(),
    phase: trackedPhase(tracker, feature),
    reason,
  });
}
