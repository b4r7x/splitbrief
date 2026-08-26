import type { PlanResult, Planner } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { publishPlannerStatus, publishWarning } from '../events.js';
import { addUsageAndSave } from '../state-ops.js';
import { collectAndPersistClarifications } from '../clarifications.js';
import { drainAndFormat } from './queue-drain.js';
import { handlePlanningFailure } from './failure.js';
import { planningError } from './errors.js';
import { persistPhases } from './io.js';
import { runPlannerCallInContinuationLoop } from './call-loop.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';
import { withRewindFeedback } from './rewind-feedback.js';
import { parkedResult } from './brief-quality-preparation.js';
import { publishProducerGeneration, settleApprovedAdmission } from './brief-publication.js';
import { planningResultForState, terminalPlanningResult } from './handoff.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { PhaseSchema } from '../../../core/schemas/enums.js';
import { labelError } from '../../../utils/format-errors.js';

function syncRecoveryState(opts: PlanningPhaseOptions, state: typeof opts.state): void {
  if (
    opts.recovery !== undefined &&
    (state.stateRevision ?? 0) > opts.recovery.authority.stateRevision
  ) {
    opts.recovery.writeState(state);
  }
}

function quickPlannerWithoutAutomaticRetry(planner: Planner): Planner {
  return {
    ...planner,
    plan: (options) => planner.quickPlan(options),
  };
}

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
      planner: quickPlannerWithoutAutomaticRetry(planner),
      feature,
      mode: 'speckit',
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

  state = addUsageAndSave(wctx, state, 'planner', planResult.usage);
  syncRecoveryState(opts, state);

  if (planResult.tasks.length === 0) {
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message:
        'quick mode: the planner produced text but no parsable Task Brief; the failed attempt contributes no Brief generation',
      safety: { category: 'planner', code: 'planner_returned_zero_tasks', transcriptSafe: true },
    });
    if (opts.recovery === undefined) {
      return parkedResult({ recovery: opts.recovery, sessionId, state });
    }
    return handlePlanningFailure({
      err: planningError.zeroTasks('quick'),
      projectDir,
      sessionId,
      state,
      wctx,
    });
  }

  // The fixed tasks.md is a compatibility projection that may be refreshed
  // only after the authoritative generation commit, so the publication seam
  // writes it and the phase persistence here carries only the support
  // documents. Without the owner binding, the producer publishes the
  // generation itself and parks the committed authority.
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
      persistTranscript: wctx.config.workflow.persistTranscript,
      bus: wctx.bus,
      metadata,
      planner,
    });
    syncRecoveryState(opts, state);
  }

  if (opts.recovery === undefined) {
    const published = publishProducerGeneration({
      ref: { projectDir, sessionId },
      state,
      planResult,
      bus: wctx.bus,
      phase: state.phase,
      metadata,
    });
    if (!published.ok) {
      publishWarning({
        bus: wctx.bus,
        phase: state.phase,
        message: `quick mode: the Task Brief could not be published; ${published.message}`,
        safety: { category: 'planning', code: 'brief_publication_blocked', transcriptSafe: true },
      });
      return parkedResult({
        recovery: opts.recovery,
        sessionId,
        state: { ...state, tasks: planResult.tasks },
      });
    }
    state = {
      ...state,
      phase: PhaseSchema.parse(published.committed.recovery.phase),
      briefRecovery: published.committed.recovery.briefRecovery,
      authorityRevision: published.committed.authorityRevision,
      generation: published.committed.generation,
      permit: published.committed.permit,
    };
  }

  // The workflow owner admits the quick Brief; the settlement then issues the
  // execution permit for the approved generation and hands the exact persisted
  // generation and permit to the task runner.
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
          message: `quick mode: the approved Task Briefs could not receive their execution permit; ${settled.message}`,
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
        message: labelError('quick mode: the Task Brief admission failed', err),
        safety: { category: 'planning', code: 'brief_admission_failed', transcriptSafe: true },
      });
      const parked = opts.recovery.readState();
      return parkedResult({ recovery: opts.recovery, sessionId, state: parked });
    }
  }

  return parkedResult({
    recovery: opts.recovery,
    sessionId,
    state: { ...state, tasks: planResult.tasks },
  });
}
