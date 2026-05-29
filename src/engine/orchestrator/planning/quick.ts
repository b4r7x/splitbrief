import type { PlanResult } from '../../planners/types.js';
import { publishPlannerStatus } from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import {
  drainAndFormat,
  handlePlanningFailure,
  runBriefQualityGate,
} from './briefs-approval-loop.js';
import { persistPhases } from './planning-io.js';
import { runPlannerCallInContinuationLoop } from './planner-call-loop.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';
import { firstBriefError } from '../../spec/brief-quality.js';

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
      err: new Error(
        `brief quality gate failed: ${firstError?.code ?? 'unknown'} in ${String(firstError?.taskId ?? 'unknown')}`,
      ),
      projectDir,
      sessionId,
      state,
      wctx,
    });
  }

  state = transitionAndSave(projectDir, sessionId, state, {
    type: 'START_QUICK',
    tasks: planResult.tasks,
  });
  publishPlannerStatus(wctx.bus, state, 'running');
  wctx.bus.publish({ type: 'plan_approved', ts: Date.now(), phase: state.phase });

  return { state, tasks: planResult.tasks, cancelled: false };
}
