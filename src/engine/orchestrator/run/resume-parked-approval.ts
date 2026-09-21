import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { PlannerCallbacksContext, WorkflowContext } from '../types.js';
import type { Planner } from '../../planners/types.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import { resumeBriefsApproval } from '../planning/resume-briefs.js';
import { resumeArtifactApproval } from '../planning/resume-artifact-approval.js';
import { invalidateFrom } from '../planning/invalidate.js';
import { runPlanningSteps } from '../planning/steps.js';
import { plannerCallbacksContextOf } from './planner-callbacks-context.js';
import { APPROVAL_PARKED_ARTIFACT } from './task-execution.js';

// Continues a resumed artifact approval from the persisted artifacts, never from a fresh
// planning turn: the approved artifact stays, everything the approval invalidated is
// dropped, and the step loop re-runs exactly the calls that lost their artifact before
// the next gate opens.
export async function continueApprovedArtifact(opts: {
  wctx: PlannerCallbacksContext & { planner: Planner };
  phase: 'reviewing-spec' | 'reviewing-plan';
  approval: { state: WorkflowState; regenerated: boolean };
  setTrackedState: (s: WorkflowState) => void;
}): Promise<PlanningPhaseResult> {
  const { wctx, setTrackedState } = opts;
  const { projectDir, sessionId, planner } = wctx;
  const ref = { projectDir, sessionId };
  const { state, regenerated } = opts.approval;
  const gate = opts.phase === 'reviewing-spec' ? 'spec' : 'plan';

  if (regenerated) invalidateFrom(ref, gate);

  const steps = await runPlanningSteps({
    wctx,
    planner,
    state,
    feature: state.feature,
    startAt: regenerated ? gate : gate === 'spec' ? 'plan' : 'tasks',
    passedGates: gate === 'spec' ? ['spec'] : ['spec', 'plan'],
  });
  setTrackedState(steps.state);
  if (steps.disposition === 'terminal') return steps;

  const briefs = await resumeBriefsApproval({ wctx, state: steps.state });
  setTrackedState(briefs.state);
  return briefs;
}

/** Resumes a run parked at an approval gate. Returns null when the state is not parked. */
export async function resumeParkedApproval(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  phaseTimings: Record<string, number>;
  startTime: number;
}): Promise<PlanningPhaseResult | null> {
  const { wctx, state, setTrackedState, phaseTimings, startTime } = opts;
  if (APPROVAL_PARKED_ARTIFACT[state.phase] === undefined) return null;

  const resumeWctx: PlannerCallbacksContext & { planner: Planner } = {
    ...plannerCallbacksContextOf(wctx),
    planner: wctx.planner,
  };

  if (state.phase === 'reviewing-spec' || state.phase === 'reviewing-plan') {
    const phase = state.phase;
    const resumed = await resumeArtifactApproval({ wctx: resumeWctx, state, phase });
    const continued: PlanningPhaseResult = resumed.closed
      ? { disposition: 'terminal', state: resumed.state, outcome: 'closed' }
      : resumed.cancelled
        ? { disposition: 'terminal', state: resumed.state, outcome: 'cancelled' }
        : await continueApprovedArtifact({
            wctx: resumeWctx,
            phase,
            approval: resumed,
            setTrackedState,
          });
    setTrackedState(continued.state);
    phaseTimings.planning = Date.now() - startTime;
    return continued;
  }

  const briefs = await resumeBriefsApproval({ wctx: resumeWctx, state });
  setTrackedState(briefs.state);
  phaseTimings.planning = Date.now() - startTime;
  return briefs;
}
