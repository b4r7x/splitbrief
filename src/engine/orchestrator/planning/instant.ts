import type { PlannerCallbacks, PlanResult } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import {
  createBusTextHandler,
  publishPlannerStatus,
  publishRunnerCallEvent,
  publishWarning,
} from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { collectAndPersistClarifications } from '../clarifications.js';
import { drainAndFormat } from './queue-drain.js';
import { handlePlanningFailure } from './failure.js';
import { runBriefQualityGate } from './brief-quality-gate.js';
import { persistPhases } from './io.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';
import { createTranscriptBuffer } from '../../streaming/transcript-buffer.js';
import { createSessionExpiredHandler } from '../resume-context.js';
import { createQuestionMarkerStripper } from '../../parsers/question.js';
import { firstBriefError } from '../../spec/brief-quality.js';
import { planningError } from './errors.js';
import { createClarificationQuestionCollector, mergePlannerAttempts } from './call-loop.js';
import { zeroTaskRetryPrompt } from '../../spec/prompts/zero-task-retry.js';
import { withRewindFeedback } from './rewind-feedback.js';

export async function runInstantPlanning(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, config, metadata, resumeHolder } = wctx;
  let { state } = opts;
  let feature = opts.feature;

  {
    const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, wctx.bus);
    state = drainedState;
    feature = prefix + feature;
  }
  feature = withRewindFeedback(feature, opts.rewindPending);

  const textHandler = createBusTextHandler(
    { bus: wctx.bus, phase: state.phase },
    { content: 'markdown' },
  );
  const buffer = createTranscriptBuffer({
    projectDir,
    sessionId,
    phase: 'planning',
    persistTranscript: config.workflow.persistTranscript ?? true,
  });

  const priorMessages =
    resumeHolder && resumeHolder.messages.length > 0 ? resumeHolder.messages : undefined;
  const attachments =
    opts.attachments && opts.attachments.length > 0 ? opts.attachments : undefined;
  const collected: ClarificationQuestion[] = [];
  const collectQuestions = createClarificationQuestionCollector(collected);
  const stripper = createQuestionMarkerStripper();
  const plannerCallbacks: PlannerCallbacks = {
    onOutput: (text) => {
      buffer.append(text);
      const display = stripper.push(text);
      if (display.length > 0) textHandler(display);
    },
    onWarning: (message) => publishWarning({ bus: wctx.bus, phase: state.phase, message: message }),
    onSessionId: (id) => {
      state = transitionAndSave({ projectDir, sessionId }, state, {
        type: 'SET_PLANNER_SESSION_ID',
        sessionId: id,
      });
    },
    onSessionExpired: createSessionExpiredHandler({
      projectDir,
      sessionId,
      bus: wctx.bus,
      config,
      resumeHolder,
    }),
    sessionId,
    persistTranscript: config.workflow.persistTranscript,
    onCallEvent: (event) => publishRunnerCallEvent({ bus: wctx.bus, phase: state.phase }, event),
    onQuestion: collectQuestions,
    ...(wctx.signal !== undefined && { signal: wctx.signal }),
    ...(priorMessages ? { priorMessages } : {}),
    ...(attachments ? { attachments } : {}),
    ...(state.discoveredValidation !== undefined
      ? { discoveredValidation: state.discoveredValidation }
      : {}),
  };

  publishPlannerStatus(wctx.bus, state, 'running');

  let planResult: PlanResult;
  try {
    const instantFn = planner.instantPlan ?? planner.quickPlan ?? planner.plan;
    const runSingleCall = async (
      callFeature: string,
      callCallbacks: PlannerCallbacks,
    ): Promise<PlanResult> => {
      const result = await instantFn.call(planner, {
        feature: callFeature,
        projectDir,
        callbacks: callCallbacks,
        codebaseContext: opts.codebaseContext,
      });
      buffer.flush();
      const rest = stripper.flush();
      if (rest.length > 0) textHandler(rest);
      return result;
    };
    const parseDiagnostics: string[] = [];
    planResult = await runSingleCall(feature, {
      ...plannerCallbacks,
      onWarning: (message) => {
        parseDiagnostics.push(message);
        plannerCallbacks.onWarning?.(message);
      },
    });
    if (planResult.tasks.length === 0) {
      planResult = mergePlannerAttempts(
        planResult,
        await runSingleCall(zeroTaskRetryPrompt(feature, parseDiagnostics), plannerCallbacks),
      );
    }
  } catch (err) {
    buffer.flush();
    const rest = stripper.flush();
    if (rest.length > 0) textHandler(rest);
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

  if (collected.length > 0 && wctx.callbacks.onQuestionAsked) {
    state = await collectAndPersistClarifications({
      questions: collected,
      projectDir,
      sessionId,
      state,
      onQuestionAsked: wctx.callbacks.onQuestionAsked,
      persistTranscript: config.workflow.persistTranscript,
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
          ? `instant mode: the planner produced text but no parsable Task Brief; its output is persisted in the session directory (${phaseFiles.join(', ')})`
          : 'instant mode: the planner produced text but no parsable Task Brief',
      safety: { category: 'planner', code: 'planner_returned_zero_tasks', transcriptSafe: true },
    });
    return handlePlanningFailure({
      err: planningError.zeroTasks('instant'),
      projectDir,
      sessionId,
      state,
      wctx,
    });
  }

  wctx.bus.publish({
    type: 'instant_plan_received',
    ts: Date.now(),
    phase: state.phase,
    taskCount: planResult.tasks.length,
  });

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
    type: 'START_INSTANT',
    tasks: planResult.tasks,
  });
  publishPlannerStatus(wctx.bus, state, 'running');
  wctx.bus.publish({ type: 'plan_approved', ts: Date.now(), phase: state.phase });

  return { state, tasks: planResult.tasks, cancelled: false, failed: false };
}
