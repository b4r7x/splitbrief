import type { Summary } from '../../../core/schemas/summary.js';
import { sessionError } from '../../../core/sessions/errors.js';
import { createInitialState } from '../../../core/state/machine.js';
import { warnStderr } from '../../../lib/warn.js';
import { error } from '../../../utils/error.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import {
  WORKFLOW_CANCEL_REASON_USER,
  workflowCancelledReasonFromSignal,
} from '../../events/workflow-cancel.js';
import { saveFinalSession } from '../session-lifecycle/finalize.js';
import { buildSummary } from '../summary/build.js';
import { closeRunIfOpen } from './close.js';
import { parkRun, publishWorkflowCancellation } from './tracker.js';
import type { RunTracker, ScopedRun } from './types.js';

export async function settleRun(
  run: ScopedRun,
  tracker: RunTracker,
  cancelled: boolean,
): Promise<Summary> {
  const { opts, feature } = run;
  const signalCancellationReason = workflowCancelledReasonFromSignal(opts.signal);
  const stoppedState = tracker.state;
  if (stoppedState !== undefined) {
    if (signalCancellationReason !== undefined) {
      const closure = await closeRunIfOpen({ ...run.ref, bus: tracker.bus }, stoppedState);
      tracker.state = closure.state;
      if (tracker.result !== undefined && tracker.result.phase !== closure.state.phase) {
        tracker.result = { ...tracker.result, phase: closure.state.phase };
      }
      if (closure.closedNow)
        publishWorkflowCancellation(tracker, feature, signalCancellationReason);
    } else if (opts.signal?.aborted) {
      tracker.state = await parkRun(run, tracker, stoppedState);
    }
  }
  if (cancelled && signalCancellationReason === undefined) {
    publishWorkflowCancellation(tracker, feature, WORKFLOW_CANCEL_REASON_USER);
  }
  const result = tracker.result;
  if (!result) {
    if (cancelled) {
      const summary = buildSummary({
        ...run.summaryBase,
        state: tracker.state ?? createInitialState(feature),
      });
      saveRunSummary(run, tracker, summary);
      return summary;
    }
    throw error('workflow-no-summary', 'Unreachable: workflow did not produce a summary');
  }
  saveRunSummary(run, tracker, result);
  return result;
}

// The run's outcome is its state: a summary the session folder cannot take is said, and the
// run still returns what it did.
function saveRunSummary(run: ScopedRun, tracker: RunTracker, summary: Summary): void {
  try {
    saveFinalSession({
      projectDir: run.ref.projectDir,
      sessionId: run.ref.sessionId,
      active: run.opts.prepared.session.active,
      feature: run.feature,
      startTime: run.startTime,
      summary,
      state: tracker.state,
    });
  } catch (err) {
    if (!sessionError.isSummaryNotSaved(err)) throw err;
    warnStderr(toErrorMessage(err), 'feedback');
  }
}
