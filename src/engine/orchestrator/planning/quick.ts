import type { PlanResult } from '../../planners/types.js';
import { emit, emitPlannerStatus } from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import {
  drainAndFormat,
  handlePlanningFailure,
  persistPhases,
  runPlannerCallInContinuationLoop,
  type PlanningPhaseOptions,
  type PlanningPhaseResult,
} from './shared.js';

export async function runQuickPlanning(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, callbacks, metadata, resumeHolder } = wctx;
  let { state } = opts;
  let feature = opts.feature;

  {
    const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, callbacks);
    state = drainedState;
    feature = prefix + feature;
  }

  let planResult: PlanResult;
  try {
    const run = await runPlannerCallInContinuationLoop({
      wctx,
      state,
      planner,
      feature,
      mode: 'quick',
      ...(resumeHolder && resumeHolder.messages.length > 0 ? { priorMessages: resumeHolder.messages } : {}),
    });
    state = run.state;
    planResult = run.result;
  } catch (err) {
    return handlePlanningFailure(err, projectDir, sessionId, state, callbacks);
  }

  persistPhases(projectDir, sessionId, planResult.phases, metadata);
  state = addUsageAndSave(projectDir, sessionId, state, 'planner', planResult.usage, callbacks);

  state = transitionAndSave(projectDir, sessionId, state, { type: 'START_QUICK', tasks: planResult.tasks });
  emitPlannerStatus(callbacks, state, 'running');
  emit(projectDir, sessionId, state, 'plan_approved', undefined, {});

  return { state, tasks: planResult.tasks, cancelled: false };
}
