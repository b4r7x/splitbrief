import type { PlanResult } from '../../planners/types.js';
import { publishEvent, publishPlannerStatus } from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import {
  drainAndFormat,
  handlePlanningFailure,
  persistPhases,
  runBriefQualityGate,
  type PlanningPhaseOptions,
  type PlanningPhaseResult,
} from './shared.js';
import { createTranscriptBuffer } from '../../streaming/transcript-buffer.js';
import { createBusTextHandler } from '../events.js';
import { createSessionExpiredHandler } from '../resume-context.js';
import type { PlannerCallbacks } from '../../planners/types.js';

export async function runInstantPlanning(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, config, callbacks, metadata, resumeHolder } = wctx;
  let { state } = opts;
  let feature = opts.feature;

  if (opts.approveLevel && opts.approveLevel !== 'none' && opts.approveLevel !== 'default') {
    publishEvent(wctx.bus, {
      type: 'warning',
      ts: Date.now(),
      phase: state.phase,
      message: `approve level "${opts.approveLevel}" has no effect in instant mode`,
    });
  }

  {
    const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, wctx.bus);
    state = drainedState;
    feature = prefix + feature;
  }

  const textHandler = createBusTextHandler(wctx.bus, state.phase);
  const buffer = createTranscriptBuffer(
    projectDir, sessionId, 'planning', config.workflow.persistTranscript ?? true,
  );

  const priorMessages = resumeHolder && resumeHolder.messages.length > 0 ? resumeHolder.messages : undefined;
  const attachments = opts.attachments && opts.attachments.length > 0 ? opts.attachments : undefined;
  const plannerCallbacks: PlannerCallbacks = {
    onOutput: (text) => { textHandler(text); buffer.append(text); },
    onSessionId: (id) => {
      state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PLANNER_SESSION_ID', sessionId: id });
    },
    onSessionExpired: createSessionExpiredHandler({ projectDir, sessionId, callbacks, bus: wctx.bus, config, resumeHolder }),
    sessionId,
    persistTranscript: config.workflow.persistTranscript,
    ...(priorMessages ? { priorMessages } : {}),
    ...(attachments ? { attachments } : {}),
  };

  publishPlannerStatus(wctx.bus, state, 'running');

  let planResult: PlanResult;
  try {
    const instantFn = planner.instantPlan ?? planner.quickPlan ?? planner.plan;
    planResult = await instantFn.call(planner, feature, projectDir, plannerCallbacks, opts.codebaseContext);
    buffer.flush();
  } catch (err) {
    buffer.flush();
    return handlePlanningFailure(err, projectDir, sessionId, state, wctx);
  }

  persistPhases(projectDir, sessionId, planResult.phases, metadata);
  state = addUsageAndSave(projectDir, sessionId, state, 'planner', planResult.usage, wctx.bus);

  if (planResult.tasks.length === 0) {
    return handlePlanningFailure(
      new Error('instant planner returned zero tasks; cannot proceed'),
      projectDir, sessionId, state, wctx,
    );
  }

  publishEvent(wctx.bus, {
    type: 'instant_plan_received',
    ts: Date.now(),
    phase: state.phase,
    taskCount: planResult.tasks.length,
  });

  const { report: qualityReport, ok: qualityOk } = runBriefQualityGate(planResult.tasks, projectDir, sessionId, wctx.bus, state.phase);
  if (!qualityOk) {
    const firstError = qualityReport.issues.find(i => i.severity === 'error');
    return handlePlanningFailure(
      new Error(`brief quality gate failed: ${firstError?.code ?? 'unknown'} in ${String(firstError?.taskId ?? 'unknown')}`),
      projectDir, sessionId, state, wctx,
    );
  }

  state = transitionAndSave(projectDir, sessionId, state, { type: 'START_INSTANT', tasks: planResult.tasks });
  publishPlannerStatus(wctx.bus, state, 'done');
  publishEvent(wctx.bus, { type: 'plan_approved', ts: Date.now(), phase: state.phase });

  return { state, tasks: planResult.tasks, cancelled: false };
}
