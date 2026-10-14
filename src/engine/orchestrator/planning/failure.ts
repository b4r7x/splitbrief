import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { PlanningPhaseResult } from './types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { publishError } from '../events.js';
import { workflowCancelledReasonFromSignal } from '../../events/workflow-cancel.js';
import {
  parkStoppedRun,
  raisePendingRecovery,
  rebaseOnPersistedWorkflowState,
} from '../state-ops.js';
import {
  diagnosePlannerCallFailure,
  plannerCallHaltIssue,
} from '../recovery/planner-call-failure.js';
import {
  apiContextRecoveryFacts,
  readApiContextDiagnostic,
} from '../../providers/api-context-diagnostic.js';
import { labelError } from '../../../utils/format-errors.js';
import { isAbortError } from '../../../utils/abort.js';
import { recoveryActionLabel } from '../../../core/recovery/action-label.js';
import { runnerHaltRow } from '../recovery/builders/task.js';

export async function handlePlanningFailure(opts: {
  err: unknown;
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  wctx: PlannerCallbacksContext;
}): Promise<Extract<PlanningPhaseResult, { disposition: 'terminal' }>> {
  const { err, projectDir, sessionId, state, wctx } = opts;
  const ref = { projectDir, sessionId };
  const latest = rebaseOnPersistedWorkflowState(ref, state);

  // A user abort is not a failure: the step it cut is recorded so the run picks
  // up there, and the run stays open. Only the operator aborts the workflow
  // signal, and a CLI or API runner wraps that abort in its own call error, so
  // the signal decides; a runner's own timeout never aborts it.
  if (isAbortError(err) || wctx.signal?.aborted === true) {
    // End run closes the run behind this branch and keeps no park, so a stop row here would sit
    // in a closed run's log inviting a retry.
    const ending = workflowCancelledReasonFromSignal(wctx.signal) !== undefined;
    return {
      disposition: 'terminal',
      state: ending ? latest : await parkStoppedRun({ ...ref, bus: wctx.bus }, latest),
      outcome: ending ? 'cancelled' : 'interrupted',
    };
  }

  // A packet the seat was never given is read off the error's own data before
  // any wording is inspected: an auth or quota heuristic run over this sentence
  // would answer a call that was never dispatched with a login command.
  const contextDiagnostic = readApiContextDiagnostic(err);
  if (contextDiagnostic !== null) {
    const message = labelError('Planning failed', err);
    publishError({ bus: wctx.bus, phase: latest.phase, message });
    const issue = await plannerCallHaltIssue({
      projectDir,
      config: wctx.config,
      diagnosis: { failure: 'call-failed', message },
      phase: latest.phase,
      seatSwitches: latest.seatSwitches,
      swap: { seat: 'plan', runner: wctx.config.planner },
      details: [
        ...(contextDiagnostic.missingSections.length > 0
          ? [`Missing: ${contextDiagnostic.missingSections.join(', ')}`]
          : []),
        `Pick a plan seat with a larger context in /crew plan, then choose ${recoveryActionLabel('retry-same-worker')}.`,
      ],
      // The estimates stay in facts: `details[]` renders inline and truncates.
      facts: apiContextRecoveryFacts(contextDiagnostic),
    });
    return {
      disposition: 'terminal',
      state: raisePendingRecovery({ ...ref, bus: wctx.bus }, latest, issue),
      outcome: 'halted',
    };
  }

  const diagnosis = diagnosePlannerCallFailure({
    err,
    label: 'Planning failed',
    runner: wctx.config.planner,
    seat: 'plan',
  });
  const issue = await plannerCallHaltIssue({
    projectDir,
    config: wctx.config,
    diagnosis,
    phase: latest.phase,
    seatSwitches: latest.seatSwitches,
    swap: { seat: 'plan', runner: wctx.config.planner },
  });
  publishError({
    bus: wctx.bus,
    phase: latest.phase,
    message:
      diagnosis.seatDown === undefined
        ? diagnosis.message
        : runnerHaltRow(issue, diagnosis.seatDown.words),
    resetAt: diagnosis.resetsAt?.toISOString(),
  });

  return {
    disposition: 'terminal',
    state: raisePendingRecovery({ ...ref, bus: wctx.bus }, latest, issue),
    outcome: 'halted',
  };
}
