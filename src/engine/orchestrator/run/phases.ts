import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { EngineEvent } from '../../events/types.js';
import type { PlanningPhaseResult } from '../planning/types.js';
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
  selectedSkills: SkillMeta[] | undefined;
  phaseTimings: Record<string, number>;
  startTime: number;
  setTrackedState: (s: WorkflowState) => void;
  rewindFeedback?: string | undefined;
};

function isInterruptedPlanningTurn(state: WorkflowState): boolean {
  return (
    state.awaitingContinue &&
    (state.phase === 'researching' || state.phase === 'specifying' || state.phase === 'planning')
  );
}

export async function runPlanningPhases(
  opts: RunPlanningPhasesOptions,
): Promise<PlanningPhaseResult> {
  const {
    wctx,
    savedState,
    selectedSkills,
    phaseTimings,
    startTime,
    setTrackedState,
    rewindFeedback,
  } = opts;
  let { state } = opts;
  const { projectDir, sessionId, config, planner } = wctx;

  const interrupted = isInterruptedPlanningTurn(state);
  const shouldRunPlanning = !savedState || Boolean(savedState.rewindPending) || interrupted;
  const rewindPending =
    savedState?.rewindPending === undefined
      ? undefined
      : {
          ...savedState.rewindPending,
          ...(rewindFeedback !== undefined && { comment: rewindFeedback }),
        };

  if (interrupted) {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'CONTINUE_TURN' });
    setTrackedState(state);
  }

  if (!shouldRunPlanning) {
    const parked = await resumeParkedApproval({
      wctx,
      state,
      setTrackedState,
      phaseTimings,
      startTime,
    });
    if (parked !== null) return parked;
    return { disposition: 'ready-for-tasks', state, tasks: state.tasks };
  }

  if (config.hooks) {
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
    if (!pre.allow) {
      publishWarning({
        bus: wctx.bus,
        phase: state.phase,
        message: `pre_planning blocked: ${pre.reason ?? 'hook denied'}`,
      });
      return { disposition: 'terminal', state, outcome: 'cancelled' };
    }
  }

  const plannerFeature = wctx.plannerContext
    ? `${state.feature}\n\n<user-context>\n${wctx.plannerContext}\n</user-context>`
    : state.feature;
  const planning = await runPlanningPhase({
    wctx: plannerCallbacksContextOf(wctx),
    planner,
    state,
    feature: plannerFeature,
    selectedSkills,
    ...(rewindPending !== undefined && { rewindPending }),
  });
  setTrackedState(planning.state);
  phaseTimings.planning = Date.now() - startTime;
  return planning;
}
