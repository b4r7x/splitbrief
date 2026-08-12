import type { PlanResult } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { publishPlannerStatus, publishWarning } from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { collectAndPersistClarifications } from '../clarifications.js';
import { drainAndFormat } from './queue-drain.js';
import { handlePlanningFailure } from './failure.js';
import { runBriefQualityGate } from './brief-quality-gate.js';
import { persistPhases } from './io.js';
import { runPlannerCallInContinuationLoop } from './call-loop.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';
import { firstBriefError } from '../../spec/brief-quality.js';
import { planningError } from './errors.js';
import { withRewindFeedback } from './rewind-feedback.js';

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
  feature = withRewindFeedback(feature, opts.rewindPending);

  const collectedQuestions: ClarificationQuestion[] = [];
  let planResult: PlanResult;
  try {
    const run = await runPlannerCallInContinuationLoop({
      wctx,
      state,
      planner,
      feature,
      mode: 'quick',
      collectedQuestions,
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

  persistPhases({
    projectDir,
    sessionId,
    phases: planResult.phases,
    metadata,
    bus: wctx.bus,
    phase: state.phase,
  });
  state = addUsageAndSave(wctx, state, 'planner', planResult.usage);

  if (collectedQuestions.length > 0 && wctx.callbacks.onQuestionAsked) {
    state = await collectAndPersistClarifications({
      questions: collectedQuestions,
      projectDir,
      sessionId,
      state,
      onQuestionAsked: wctx.callbacks.onQuestionAsked,
      persistTranscript: wctx.config.workflow.persistTranscript,
      bus: wctx.bus,
      metadata,
      planner,
    });
  }

  if (planResult.tasks.length === 0) {
    const phaseFiles = (planResult.phases ?? []).map((phase) => phase.filename);
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message:
        phaseFiles.length > 0
          ? `quick mode: the planner produced text but no parsable Task Brief; its output is persisted in the session directory (${phaseFiles.join(', ')})`
          : 'quick mode: the planner produced text but no parsable Task Brief',
      safety: { category: 'planner', code: 'planner_returned_zero_tasks', transcriptSafe: true },
    });
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

  return { state, tasks: planResult.tasks, cancelled: false, failed: false };
}
