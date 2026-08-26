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
import { persistPhases } from './io.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';
import { createTranscriptBuffer } from '../../streaming/transcript-buffer.js';
import { createSessionExpiredHandler } from '../resume-context.js';
import { workflowAuthority } from '../run/authority.js';
import { createQuestionMarkerStripper } from '../../parsers/question.js';
import { firstBriefError } from '../../spec/brief-quality.js';
import { planningError } from './errors.js';
import { createClarificationQuestionCollector, mergePlannerAttempts } from './call-loop.js';
import { zeroTaskRetryPrompt } from '../../spec/prompts/zero-task-retry.js';
import { withRewindFeedback } from './rewind-feedback.js';
import { parkedResult } from './brief-quality-preparation.js';
import { planningResultForState, terminalPlanningResult } from './handoff.js';
import {
  publishProducerGeneration,
  settleApprovedAdmission,
  type BriefPublicationResult,
} from './brief-publication.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { writeBriefQualityReport } from '../../spec/brief-quality-file.js';
import { PhaseSchema } from '../../../core/schemas/enums.js';
import { labelError } from '../../../utils/format-errors.js';

type CommittedEnforcement = Extract<BriefPublicationResult, { ok: true }>['committed'];

function syncRecoveryState(opts: PlanningPhaseOptions, state: typeof opts.state): void {
  if (
    opts.recovery !== undefined &&
    (state.stateRevision ?? 0) > opts.recovery.authority.stateRevision
  ) {
    opts.recovery.writeState(state);
  }
}

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
      authority: workflowAuthority(wctx),
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

  state = addUsageAndSave(wctx, state, 'planner', planResult.usage);
  syncRecoveryState(opts, state);

  if (planResult.tasks.length === 0) {
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message:
        'instant mode: the planner produced text but no parsable Task Brief; the failed attempt contributes no Brief generation',
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

  // The owner-owned publication seam evaluates the Brief contract, installs
  // the immutable generation, and commits the parked enforcement authority.
  // A quality fault blocks the run and its diagnostic report is the seam's
  // evaluated report; any other fault parks with the previous authority.
  let committedEnforcement: CommittedEnforcement | null = null;
  if (opts.recovery === undefined) {
    const publication = publishProducerGeneration({
      ref: { projectDir, sessionId },
      state,
      planResult,
      bus: wctx.bus,
      phase: state.phase,
      metadata,
    });
    if (publication.ok) {
      committedEnforcement = publication.committed;
    } else if (publication.fault === 'quality') {
      writeBriefQualityReport({
        ref: { projectDir, sessionId },
        content: { issues: publication.report.issues },
        metadata: null,
      });
      const errorCount = publication.report.issues.filter(
        (issue) => issue.severity === 'error',
      ).length;
      const warningCount = publication.report.issues.filter(
        (issue) => issue.severity === 'warning',
      ).length;
      wctx.bus.publish({
        type: 'brief_quality_failed',
        ts: Date.now(),
        phase: state.phase,
        score: publication.report.score,
        errorCount,
        warningCount,
      });
      const firstError = firstBriefError(publication.report);
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
    } else {
      publishWarning({
        bus: wctx.bus,
        phase: state.phase,
        message: `instant mode: the Task Brief could not be published; ${publication.message}`,
        safety: { category: 'planning', code: 'brief_publication_blocked', transcriptSafe: true },
      });
      return parkedResult({
        recovery: opts.recovery,
        sessionId,
        state: { ...state, tasks: planResult.tasks },
      });
    }
  }

  // The fixed tasks.md is a compatibility projection that may be refreshed
  // only after the authoritative generation commit, so the publication seam
  // writes it and the phase persistence here carries only the support
  // documents. brief-quality.json follows the same rule: the success path
  // leaves it to the publication seam, and the quality fault above wrote it
  // only as the terminal diagnostic of a blocked run. Without the owner
  // binding, the producer publishes the generation itself and parks the
  // committed authority.
  persistPhases({
    projectDir,
    sessionId,
    phases: (planResult.phases ?? []).filter((phase) => phase.artifact.logicalName !== TASKS_FILE),
    metadata,
    bus: wctx.bus,
    phase: state.phase,
  });

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
    syncRecoveryState(opts, state);
  }

  if (committedEnforcement !== null) {
    state = {
      ...state,
      phase: PhaseSchema.parse(committedEnforcement.recovery.phase),
      briefRecovery: committedEnforcement.recovery.briefRecovery,
      authorityRevision: committedEnforcement.authorityRevision,
      generation: committedEnforcement.generation,
      permit: committedEnforcement.permit,
    };
  }

  wctx.bus.publish({
    type: 'instant_plan_received',
    ts: Date.now(),
    phase: state.phase,
    taskCount: planResult.tasks.length,
  });

  // The workflow owner admits the instant Brief; the settlement then issues
  // the execution permit for the approved generation before the task runner
  // receives the exact persisted generation and permit.
  if (opts.recovery !== undefined) {
    try {
      const admission = await opts.recovery.controller.enterBriefAdmission(
        opts.recovery.createAdmissionInput({
          tasks: planResult.tasks,
          state,
          projectDir,
          sessionId,
        }),
        opts.recovery.authority,
      );
      if (admission.kind === 'rejected') {
        const rejected = opts.recovery.readState();
        return terminalPlanningResult(rejected, 'rejected');
      }
      if (admission.kind !== 'ready') {
        const parked = opts.recovery.readState();
        return parkedResult({ recovery: opts.recovery, sessionId, state: parked });
      }
      const admitted = opts.recovery.readState();
      const settled = settleApprovedAdmission({
        ref: { projectDir, sessionId },
        state: admitted,
        tasks: planResult.tasks,
        bus: wctx.bus,
        writeState: opts.recovery.writeState,
      });
      if (!settled.ok) {
        publishWarning({
          bus: wctx.bus,
          phase: state.phase,
          message: `instant mode: the approved Task Briefs could not receive their execution permit; ${settled.message}`,
          safety: { category: 'planning', code: 'brief_permit_refused', transcriptSafe: true },
        });
        return parkedResult({
          recovery: opts.recovery,
          sessionId,
          state: opts.recovery.readState(),
        });
      }
      state = settled.state;
      publishPlannerStatus(wctx.bus, state, 'running');
      return planningResultForState({ sessionId, state, tasks: planResult.tasks });
    } catch (err) {
      publishWarning({
        bus: wctx.bus,
        phase: state.phase,
        message: labelError('instant mode: the Task Brief admission failed', err),
        safety: { category: 'planning', code: 'brief_admission_failed', transcriptSafe: true },
      });
      const parked = opts.recovery.readState();
      return parkedResult({ recovery: opts.recovery, sessionId, state: parked });
    }
  }

  if (state.rewindPending !== undefined) {
    state = transitionAndSave({ projectDir, sessionId }, state, {
      type: 'CLEAR_REWIND_PENDING',
    });
  }
  return parkedResult({
    recovery: opts.recovery,
    sessionId,
    state: { ...state, tasks: planResult.tasks },
  });
}
