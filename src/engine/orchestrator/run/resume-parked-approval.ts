import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { PlannerCallbacksContext, WorkflowContext } from '../types.js';
import type { Planner } from '../../planners/types.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import {
  parkedPlanningResult,
  terminalPlanningResult,
  withPlanningResultState,
} from '../planning/handoff.js';
import { resumeBriefsApproval } from '../planning/resume-briefs.js';
import { resumeArtifactApproval } from '../planning/resume-artifact-approval.js';
import { regeneratePlanAndTasks, regenerateTasksIfNeeded } from '../planning/regen.js';
import { runBriefQuality, type BriefQualityRunResult } from '../planning/brief-quality-run.js';
import { transitionAndSave } from '../state-ops.js';
import { applyBriefQualityResult, stateAfterRecovery } from './phase-recovery-state.js';
import type { PhaseRecoveryBinding } from './phases.js';
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
  recovery: PhaseRecoveryBinding;
}): Promise<PlanningPhaseResult> {
  const { wctx, setTrackedState, recovery } = opts;
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
    } catch {
      const preserved = stateAfterRecovery(state, recovery);
      setTrackedState(preserved);
      return parkedPlanningResult(wctx.sessionId, preserved, recovery.projection);
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
      return terminalPlanningResult(planApproval.state, 'cancelled');
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
  } catch {
    const preserved = stateAfterRecovery(state, recovery);
    setTrackedState(preserved);
    return parkedPlanningResult(wctx.sessionId, preserved, recovery.projection);
  }
  state = regen.state;
  tasks = regen.tasks;

  let quality: BriefQualityRunResult;
  try {
    quality = await runBriefQuality({
      tasks,
      state,
      planner,
      wctx,
      recovery,
    });
  } catch {
    const preserved = stateAfterRecovery(state, recovery);
    setTrackedState(preserved);
    return parkedPlanningResult(wctx.sessionId, preserved, recovery.projection);
  }
  applyBriefQualityResult(recovery, quality);
  const latest = stateAfterRecovery(quality.state, recovery);
  setTrackedState(latest);
  if (!quality.ok) return withPlanningResultState(quality.result, latest);

  const briefs = await resumeBriefsApproval({
    wctx,
    state: latest,
    qualityValidatedTasks: quality.tasks,
    recovery,
  });
  const finalState = stateAfterRecovery(briefs.state, recovery);
  setTrackedState(finalState);
  return withPlanningResultState(briefs, finalState);
}

/** Resumes a run parked at an approval gate. Returns null when the state is not parked. */
export async function resumeParkedApproval(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  recovery: PhaseRecoveryBinding | undefined;
  phaseTimings: Record<string, number>;
  startTime: number;
}): Promise<PlanningPhaseResult | null> {
  const { wctx, setTrackedState, recovery, phaseTimings, startTime } = opts;
  if (APPROVAL_PARKED_ARTIFACT[opts.state.phase] === undefined) return null;
  if (recovery === undefined) return parkedPlanningResult(wctx.sessionId, opts.state);

  const resumeWctx: PlannerCallbacksContext & { planner: Planner } = {
    ...plannerCallbacksContextOf(wctx),
    planner: wctx.planner,
  };

  if (opts.state.phase === 'reviewing-briefs') {
    const resumed = await resumeBriefsApproval({
      wctx: resumeWctx,
      state: opts.state,
      recovery,
    });
    const state = stateAfterRecovery(resumed.state, recovery);
    setTrackedState(state);
    phaseTimings.planning = Date.now() - startTime;
    return withPlanningResultState(resumed, state);
  }

  const resumePhase = opts.state.phase;
  if (resumePhase === 'reviewing-spec' || resumePhase === 'reviewing-plan') {
    const resumed = await resumeArtifactApproval({
      wctx: resumeWctx,
      state: opts.state,
      phase: resumePhase,
    });
    const continued = resumed.cancelled
      ? terminalPlanningResult(resumed.state, 'cancelled')
      : await continueApprovedArtifact({
          wctx: resumeWctx,
          phase: resumePhase,
          approval: resumed,
          setTrackedState,
          recovery,
        });
    setTrackedState(continued.state);
    phaseTimings.planning = Date.now() - startTime;
    return withPlanningResultState(continued, continued.state);
  }

  return null;
}
