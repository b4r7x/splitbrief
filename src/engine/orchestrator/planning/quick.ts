import type { PlanResult } from '../../planners/types.js';
import { publishPlannerStatus } from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { drainAndFormat } from './queue-drain.js';
import { handlePlanningFailure } from './failure.js';
import { runBriefQualityGate } from './brief-quality-gate.js';
import { persistPhases } from './io.js';
import { runPlannerCallInContinuationLoop } from './call-loop.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';
import { firstBriefError } from '../../spec/brief-quality.js';
import { planningError } from './errors.js';

export async function runQuickPlanning(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, metadata, resumeHolder } = wctx;
  let { state } = opts;
  let feature = opts.feature;

  {
    const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, wctx.bus);
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
      ...(opts.codebaseContext !== undefined ? { codebaseContext: opts.codebaseContext } : {}),
      ...(resumeHolder && resumeHolder.messages.length > 0
        ? { priorMessages: resumeHolder.messages }
        : {}),
      ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
      phaseHint: 'generating plan',
    });
    state = run.state;
    planResult = run.result;
  } catch (err) {
    return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
  }

  persistPhases(projectDir, sessionId, planResult.phases, metadata);
  state = addUsageAndSave(wctx, state, 'planner', planResult.usage);

  if (planResult.tasks.length === 0) {
    return handlePlanningFailure({
      err: planningError.zeroTasks('quick'),
      projectDir,
      sessionId,
      state,
      wctx,
    });
  }

  const { report: qualityReport, ok: qualityOk } = runBriefQualityGate({
    tasks: planResult.tasks,
    projectDir,
    sessionId,
    bus: wctx.bus,
    phase: state.phase,
  });
  if (!qualityOk) {
    const firstError = firstBriefError(qualityReport);
    return handlePlanningFailure({
      err: planningError.briefQualityGateFailed(
        firstError?.code ?? 'unknown',
        String(firstError?.taskId ?? 'unknown'),
      ),
      projectDir,
      sessionId,
      state,
      wctx,
    });
  }

  state = transitionAndSave({ projectDir, sessionId }, state, {
    type: 'START_QUICK',
    tasks: planResult.tasks,
  });
  publishPlannerStatus(wctx.bus, state, 'running');
  wctx.bus.publish({ type: 'plan_approved', ts: Date.now(), phase: state.phase });

  return { state, tasks: planResult.tasks, cancelled: false };
}
