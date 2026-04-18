import type { Planner } from '../../planners/types.js';
import { emit, createTextHandler, emitPlannerStatus } from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { createSessionExpiredHandler } from '../resume-context.js';
import { withContinuationLoop } from '../continuation.js';
import {
  drainAndFormat,
  handlePlanningFailure,
  persistPhases,
  type PlanningPhaseOptions,
  type PlanningPhaseResult,
} from './shared.js';

export async function runQuickPlanning(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, config, callbacks, metadata, resumeHolder, sinks } = wctx;
  let { state } = opts;
  let feature = opts.feature;

  {
    const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, callbacks);
    state = drainedState;
    feature = prefix + feature;
  }

  const textHandler = createTextHandler(callbacks);
  type PlanFnResult = Awaited<ReturnType<Planner['plan']>>;
  let planResult: PlanFnResult;

  try {
    const loop = await withContinuationLoop<PlanFnResult>({
      ctx: { projectDir, sessionId, callbacks, signal: wctx.signal, sinks },
      state,
      onStateChange: (s) => { state = s; },
      body: async ({ continuationPrompt, recordOutput }) => {
        const quickPlanFn = planner.quickPlan ?? planner.plan;
        const prompt = continuationPrompt ?? feature;
        const result = await quickPlanFn.call(planner, prompt, projectDir, {
          onOutput: (text) => { recordOutput(text); textHandler(text); },
          onSessionId: (id) => { state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PLANNER_SESSION_ID', sessionId: id }); },
          onSessionExpired: createSessionExpiredHandler({ projectDir, sessionId, callbacks, config, resumeHolder }),
          sessionId,
          persistTranscript: config.workflow.persistTranscript,
          ...(resumeHolder && resumeHolder.messages.length > 0 ? { priorMessages: resumeHolder.messages } : {}),
        });
        return { value: result };
      },
    });
    state = loop.state;
    planResult = loop.value;
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
