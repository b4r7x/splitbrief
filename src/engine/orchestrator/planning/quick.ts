import type { PlanResult, Planner } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { publishWarning } from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { collectAndPersistClarifications } from '../clarifications.js';
import { drainAndFormat } from './queue-drain.js';
import { handlePlanningFailure } from './failure.js';
import { planningError } from './errors.js';
import { persistPhases } from './io.js';
import { runPlannerCallInContinuationLoop } from './call-loop.js';
import type { PlanningPhaseOptions, PlanningProducerResult } from './types.js';
import { withRewindFeedback } from './rewind-feedback.js';
import { TASKS_FILE } from '../../../core/paths.js';

function plannerUsingQuickPlan(planner: Planner): Planner {
  return {
    ...planner,
    plan: (options) => planner.quickPlan(options),
  };
}

export async function runQuickPlanning(
  opts: PlanningPhaseOptions,
): Promise<PlanningProducerResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, metadata, resumeHolder } = wctx;
  let { state } = opts;
  let feature = opts.feature;

  {
    const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, wctx.bus);
    state = drainedState;
    feature = prefix + feature;
  }
  feature = withRewindFeedback(feature, opts.rewindPending);

  const collectedQuestions: ClarificationQuestion[] = [];
  let planResult: PlanResult;
  try {
    const run = await runPlannerCallInContinuationLoop({
      wctx,
      state,
      planner: plannerUsingQuickPlan(planner),
      feature,
      collectedQuestions,
      ...(opts.codebaseContext !== undefined ? { codebaseContext: opts.codebaseContext } : {}),
      ...(resumeHolder && resumeHolder.messages.length > 0
        ? { priorMessages: resumeHolder.messages }
        : {}),
      ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
      ...(opts.trivial === true ? { trivial: true } : {}),
      phaseHint: 'generating plan',
    });
    state = run.state;
    planResult = run.result;
  } catch (err) {
    return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
  }

  state = addUsageAndSave(wctx, state, 'planner', planResult.usage);

  if (planResult.tasks.length === 0) {
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message:
        'quick mode: the planner produced text but no parsable Task Brief; the failed attempt contributes no Brief generation',
      safety: { category: 'planner', code: 'planner_returned_zero_tasks' },
    });
    return handlePlanningFailure({
      err: planningError.zeroTasks(),
      projectDir,
      sessionId,
      state,
      wctx,
    });
  }

  // runPlanningPhase writes tasks.md after the brief quality gate, so the
  // phase persistence here carries only the support documents.
  persistPhases({
    projectDir,
    sessionId,
    phases: (planResult.phases ?? []).filter((phase) => phase.artifact.logicalName !== TASKS_FILE),
    metadata,
    bus: wctx.bus,
    phase: state.phase,
  });

  if (collectedQuestions.length > 0 && wctx.callbacks.onQuestionAsked) {
    state = await collectAndPersistClarifications({
      questions: collectedQuestions,
      projectDir,
      sessionId,
      state,
      onQuestionAsked: wctx.callbacks.onQuestionAsked,
      bus: wctx.bus,
      metadata,
      planner,
    });
  }

  state = transitionAndSave({ projectDir, sessionId }, state, {
    type: 'PLAN_DONE',
    tasks: planResult.tasks,
  });

  return {
    disposition: 'tasks-ready',
    state,
    tasks: planResult.tasks,
  };
}
