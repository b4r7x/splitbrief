import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { PlannerCallbacksContext, WorkflowContext } from '../types.js';
import type { Planner } from '../../planners/types.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import { resumeBriefsApproval } from '../planning/resume-briefs.js';
import { resumeArtifactApproval } from '../planning/resume-artifact-approval.js';
import { regeneratePlanAndTasks, regenerateTasksIfNeeded } from '../planning/regen.js';
import { handlePlanningFailure } from '../planning/failure.js';
import { transitionAndSave } from '../state-ops.js';
import { plannerCallbacksContextOf } from './planner-callbacks-context.js';
import { APPROVAL_PARKED_ARTIFACT } from './task-execution.js';

// Continues a resumed artifact approval from the persisted artifacts, never from a fresh
// planning turn: an approved spec.md drives plan/brief regeneration and then the plan gate,
// and a plan the planner revised at either gate invalidates the briefs it produced, so they
// are regenerated before the briefs gate reads tasks.md. This is what rewind.ts does after
// its own APPROVE_SPEC; re-planning would overwrite the artifact just approved and re-prompt
// the same gate.
export async function continueApprovedArtifact(opts: {
  wctx: PlannerCallbacksContext & { planner: Planner };
  phase: 'reviewing-spec' | 'reviewing-plan';
  approval: { state: WorkflowState; regenerated: boolean };
  setTrackedState: (s: WorkflowState) => void;
}): Promise<PlanningPhaseResult> {
  const { wctx, setTrackedState } = opts;
  const { projectDir, sessionId, callbacks, bus, metadata, sinks, signal, planner } = wctx;
  const ref = { projectDir, sessionId };
  let { state, regenerated } = opts.approval;
  let tasks = state.tasks;

  if (opts.phase === 'reviewing-spec') {
    state = transitionAndSave(ref, state, { type: 'APPROVE_SPEC' });
    let planAndTasks: Awaited<ReturnType<typeof regeneratePlanAndTasks>>;
    try {
      planAndTasks = await regeneratePlanAndTasks({
        ...ref,
        planner,
        callbacks,
        bus,
        state,
        metadata,
        signal,
        sinks,
      });
    } catch (err) {
      return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
    }
    tasks = planAndTasks.tasks;
    state = transitionAndSave(ref, planAndTasks.state, {
      type: 'PLAN_DONE',
      tasks,
    });
    setTrackedState(state);

    const planApproval = await resumeArtifactApproval({
      wctx,
      state,
      phase: 'reviewing-plan',
    });
    if (planApproval.cancelled) {
      return { disposition: 'terminal', state: planApproval.state, outcome: 'cancelled' };
    }
    state = planApproval.state;
    regenerated = planApproval.regenerated;
  }

  let regen: Awaited<ReturnType<typeof regenerateTasksIfNeeded>>;
  try {
    regen = await regenerateTasksIfNeeded({
      ...ref,
      regenerated,
      planner,
      callbacks,
      bus,
      state,
      tasks,
      metadata,
      signal,
      sinks,
    });
  } catch (err) {
    return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
  }
  state = regen.state;
  tasks = regen.tasks;

  const briefs = await resumeBriefsApproval({ wctx, state });
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
    const continued: PlanningPhaseResult = resumed.cancelled
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
