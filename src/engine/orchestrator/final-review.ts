import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { EventBus } from '../events/types.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { Config } from '../../core/schemas/config.js';
import { readSpecFileOrEmpty, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, TASKS_FILE } from '../../core/paths.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { getRunnerCatalogDisplayName } from '../../core/config/accessors/runner-config.js';
import { error } from '../../utils/error.js';
import { labelError } from '../../utils/format-errors.js';
import { warnError } from '../../lib/warn.js';
import { isAbortError } from '../../utils/abort.js';
import { buildFinalReviewPrompt, truncateDiffForPrompt } from '../spec/prompts/review.js';
import { recordFinalReviewEvidence } from './evidence/reporting.js';
import { formatValidationEvidenceForPrompt } from './evidence/format-validation.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import type { EvidenceLedger } from '../../core/schemas/evidence.js';
import { analyzeBriefDrift } from './drift/analyze.js';
import { writeDriftReport } from './drift/io.js';
import { formatDriftReportForPrompt, publishDriftReport } from './drift/format.js';

import type { Reviewer } from '../reviewers/types.js';
import { buildSummary, type SummaryBase } from './summary/build.js';
import { publishError, publishPlannerStatus, publishWarningFromError } from './events.js';
import { transitionAndSave } from './state-ops.js';
import { runReviewerCall } from './review-call.js';
import { hashTaskBrief } from '../brief-hash.js';
import { writeReviewPacket } from './evidence/review-packet/write.js';
import { formatTasks } from '../spec/formatter.js';
import { drainQueue } from './queue/drain.js';
import { formatDrainedMessages } from './queue/prompt.js';
import { withContinuationLoop } from './continuation.js';
import { composeSteeredPrompt } from '../spec/prompts/steered-prompt.js';
import { resolveRunUniverse } from './evidence/review-packet/sections-io.js';

export type FinalReviewResult = { summary: Summary; state: WorkflowState };

export const finalReviewError = {
  missingRunBaseline: () =>
    error(
      'final-review-missing-run-baseline',
      'Session state carries no run-start baseline, so the run diff cannot be bounded. Start a new run.',
    ),
} as const;

export async function runFinalReviewPhase(opts: {
  projectDir: string;
  sessionId: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  state: WorkflowState;
  reviewer: Reviewer;
  metadata?: SpecMetadata | null;
  signal?: AbortSignal | undefined;
  sinks?: WorkflowSinks | undefined;
  summaryBase: SummaryBase;
  taskBreakdowns: TaskTokenUsage[];
  phaseTimings?: Record<string, number>;
}): Promise<FinalReviewResult> {
  let { state } = opts;
  const {
    projectDir,
    sessionId,
    config,
    callbacks,
    bus,
    reviewer,
    metadata,
    summaryBase,
    taskBreakdowns,
    phaseTimings,
  } = opts;

  // On resume the state is already persisted in 'final-review' (a previously failed
  // gate); only dispatch ALL_DONE from 'implementing' on a fresh forward run.
  if (state.phase === 'implementing') {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'ALL_DONE' });
  }

  const finalReviewStart = Date.now();
  const interruptedSummary = (): FinalReviewResult => {
    if (phaseTimings) phaseTimings.review = Date.now() - finalReviewStart;
    publishPlannerStatus(bus, state, 'done', {
      duration: Date.now() - finalReviewStart,
      summary: 'Final review aborted',
    });
    return {
      summary: buildSummary({
        ...summaryBase,
        projectDir,
        sessionId,
        state,
        taskBreakdowns,
        ...(phaseTimings && { phaseTimings }),
      }),
      state,
    };
  };
  if (opts.signal?.aborted) return interruptedSummary();
  publishPlannerStatus(bus, state, 'running');
  bus.publish({ type: 'all_tasks_done', ts: Date.now(), phase: state.phase });

  let reviewStatus: 'written' | 'failed' = 'written';
  try {
    const baseline = state.changedFilesBaseline;
    if (baseline?.runStartChangedFiles === undefined) throw finalReviewError.missingRunBaseline();
    const universe = await resolveRunUniverse(projectDir, baseline);
    const fullDiff = universe.fullDiff;
    const promptDiff = truncateDiffForPrompt(fullDiff);
    const spec = readSpecFileOrEmpty({ projectDir, sessionId }, SPEC_FILE);
    const taskBriefs =
      readSpecFileOrEmpty({ projectDir, sessionId }, TASKS_FILE) || formatTasks(state.tasks);

    let driftPromptSection: string | undefined;
    let validationPromptSection: string | undefined;
    let ledger: EvidenceLedger | null = null;
    try {
      ledger = readEvidenceLedger({ projectDir, sessionId });
      // The review's validation claims must quote this recorded output; a
      // review left to re-derive test results invents counts.
      validationPromptSection = formatValidationEvidenceForPrompt(ledger);
    } catch (err) {
      warnError('Failed to read validation evidence', err);
    }

    try {
      const driftReport = analyzeBriefDrift({
        tasks: state.tasks,
        changedFiles: universe.changedFiles,
        diff: fullDiff,
        ledger,
        briefHash: hashTaskBrief(state.tasks),
        preRunChangedFiles: baseline.runStartChangedFiles,
      });
      writeDriftReport({ projectDir, sessionId }, driftReport);
      publishDriftReport(bus, state.phase, driftReport);
      driftPromptSection = formatDriftReportForPrompt(driftReport);
    } catch (err) {
      warnError('Failed to compute drift report', err);
    }

    const drain = drainQueue({ projectDir, sessionId, state, bus });
    state = drain.state;
    const queueText = drain.messages.length > 0 ? formatDrainedMessages(drain.messages) : '';

    const basePrompt = buildFinalReviewPrompt({
      spec,
      taskBriefs,
      diff: promptDiff,
      driftReport: driftPromptSection,
      validationEvidence: validationPromptSection,
    });
    const fullPrompt = queueText ? queueText + basePrompt : basePrompt;

    if (opts.sinks) {
      const loop = await withContinuationLoop<{ state: WorkflowState; text: string }>({
        ctx: {
          projectDir,
          sessionId,
          callbacks,
          bus,
          signal: opts.signal,
          sinks: opts.sinks,
        },
        state,
        onStateChange: (s) => {
          state = s;
        },
        body: ({ signal: callSignal, continuationPrompt, steer }) =>
          runReviewerCall({
            reviewer,
            prompt: composeSteeredPrompt(continuationPrompt ?? fullPrompt, steer),
            projectDir,
            sessionId,
            bus,
            state,
            metadata,
            signal: callSignal,
          }),
      });
      state = loop.value.state;
    } else {
      const review = await runReviewerCall({
        reviewer,
        prompt: fullPrompt,
        projectDir,
        sessionId,
        bus,
        state,
        metadata,
        signal: opts.signal,
      });
      state = review.state;
    }
  } catch (err) {
    if (opts.signal?.aborted || isAbortError(err)) return interruptedSummary();
    const seat = resolveReviewerRunner(config);
    const label =
      seat.source === 'configured'
        ? `Final review failed (reviewer: ${getRunnerCatalogDisplayName(seat.runner)})`
        : 'Final review failed';
    publishError({
      bus: bus,
      phase: state.phase,
      message: labelError(label, err),
    });
    reviewStatus = 'failed';
  }
  if (opts.signal?.aborted) return interruptedSummary();

  try {
    const ledger = readEvidenceLedger({ projectDir, sessionId });
    if (ledger) {
      writeEvidenceLedger(
        { projectDir, sessionId },
        recordFinalReviewEvidence({ ledger, status: reviewStatus }),
      );
    }
  } catch (err) {
    warnError('Failed to record final review evidence', err);
  }

  if (phaseTimings) phaseTimings.review = Date.now() - finalReviewStart;

  if (reviewStatus === 'failed') {
    publishPlannerStatus(bus, state, 'done', {
      duration: Date.now() - finalReviewStart,
      summary: 'Final review failed',
    });
  } else {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'REVIEW_DONE' });
    publishPlannerStatus(bus, state, 'done', { duration: Date.now() - finalReviewStart });
    bus.publish({ type: 'workflow_complete', ts: Date.now(), phase: state.phase });
  }

  const summaryOpts = {
    ...summaryBase,
    projectDir,
    sessionId,
    state,
    taskBreakdowns,
    ...(phaseTimings && { phaseTimings }),
  };

  const preSummary = buildSummary(summaryOpts);
  try {
    await writeReviewPacket({
      projectDir,
      sessionId,
      summary: preSummary,
      state,
      finalReviewStatus: reviewStatus,
    });
  } catch (err) {
    publishWarningFromError(
      { bus: bus, phase: state.phase },
      'Review packet generation failed',
      err,
    );
  }

  const summary = buildSummary(summaryOpts);
  if (reviewStatus !== 'failed') callbacks.onComplete(summary);
  return { summary, state };
}
