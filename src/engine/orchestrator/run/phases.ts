import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { EngineEvent } from '../../events/types.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import { artifactPresence } from '../../../core/sessions/run-record-io.js';
import { resumeStep } from '../../../core/sessions/run-status.js';
import { publishWarning } from '../events.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { runPlanningPhase } from '../planning/run.js';
import { transitionAndSave } from '../state-ops.js';
import { plannerCallbacksContextOf } from './planner-callbacks-context.js';
import { resumeParkedApproval } from './resume-parked-approval.js';

export type RunPlanningPhasesOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  savedState: WorkflowState | undefined;
  phaseTimings: Record<string, number>;
  startTime: number;
  setTrackedState: (s: WorkflowState) => void;
  rewindFeedback?: string | undefined;
};

/** A run that stopped mid-step, by the recorded step or the legacy flag. */
function isParkedMidStep(state: WorkflowState): boolean {
  return state.interruptedStep !== undefined || state.awaitingContinue;
}

export async function runPlanningPhases(
  opts: RunPlanningPhasesOptions,
): Promise<PlanningPhaseResult> {
  const { wctx, savedState, phaseTimings, startTime, setTrackedState, rewindFeedback } = opts;
  let { state } = opts;
  const { projectDir, sessionId, config, planner } = wctx;
  const rewindPending =
    savedState?.rewindPending === undefined
      ? undefined
      : {
          ...savedState.rewindPending,
          ...(rewindFeedback !== undefined && { comment: rewindFeedback }),
        };

  // Re-entering the run is the resume: the parked step is cleared here whatever
  // phase it was in, so nothing downstream still reads the run as stopped.
  if (isParkedMidStep(state)) {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'RESUME_STEP' });
    setTrackedState(state);
  }

  // Where this run picks up decides what runs at all: a brief or a review means
  // planning is behind it, a parked gate re-opens where it stopped, and anything
  // else re-issues the first planner call whose artifact is missing.
  const resume = resumeStep(state, artifactPresence({ projectDir, sessionId }));
  if (rewindPending === undefined) {
    if (resume.kind === 'brief' || resume.kind === 'review') {
      return { disposition: 'ready-for-tasks', state, tasks: state.tasks };
    }
    if (resume.kind === 'gate') {
      const parked = await resumeParkedApproval({
        wctx,
        state,
        setTrackedState,
        phaseTimings,
        startTime,
      });
      if (parked !== null) return parked;
    }
  }

  // The pre-planning hook runs once per process, immediately before the first
  // step that actually calls the planner — never for a turn that only replays
  // artifacts it already has.
  let hookRan = false;
  const beforeFirstCall = async (): Promise<boolean> => {
    if (hookRan || !config.hooks) return true;
    hookRan = true;
    const prePlanPayload: EngineEvent = {
      type: 'workflow_started',
      ts: Date.now(),
      phase: state.phase,
      feature: state.feature,
    };
    const pre = await runPreHooks(config.hooks, 'pre_planning', prePlanPayload, {
      projectDir,
      sessionId,
    });
    if (pre.allow) return true;
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message: `pre_planning blocked: ${pre.reason ?? 'hook denied'}`,
    });
    return false;
  };

  const plannerFeature = wctx.plannerContext
    ? `${state.feature}\n\n<user-context>\n${wctx.plannerContext}\n</user-context>`
    : state.feature;
  const planning = await runPlanningPhase({
    wctx: plannerCallbacksContextOf(wctx),
    planner,
    state,
    feature: plannerFeature,
    beforeFirstCall,
    ...(rewindPending !== undefined && { rewindPending }),
  });
  setTrackedState(planning.state);
  phaseTimings.planning = Date.now() - startTime;
  return planning;
}
