import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { ContinuationHolder } from './continuation.js';
import type { EventBus } from '../events/types.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
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
import { parseFinalReview, type ParsedFinalReview } from '../parsers/final-review.js';
import { VERDICT_RULES } from '../../core/pipeline-spec/review.js';
import type { ReviewPhaseStatus } from './review-fix.js';
import { hashTaskBrief } from '../brief-hash.js';
import { writeReviewPacket } from './evidence/review-packet/write.js';
import { formatTasks } from '../spec/formatter.js';
import { drainQueue } from './queue/drain.js';
import { formatDrainedMessages } from './queue/prompt.js';
import { withContinuationLoop } from './continuation.js';
import { composeContinuation } from '../spec/prompts/continuation.js';
import { resolveRunUniverse } from './evidence/review-packet/sections-io.js';

export type FinalReviewResult = {
  state: WorkflowState;
  summaryBase: SummaryBase;
  verdict: ParsedFinalReview | null;
  reviewText: string;
  reviewStatus: ReviewPhaseStatus;
};

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
  continuation?: ContinuationHolder | undefined;
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
  const interrupted = (): FinalReviewResult => {
    if (phaseTimings) phaseTimings.review = Date.now() - finalReviewStart;
    publishPlannerStatus(bus, state, 'done', {
      duration: Date.now() - finalReviewStart,
      summary: 'Final review aborted',
    });
    return { state, summaryBase, verdict: null, reviewText: '', reviewStatus: 'failed' };
  };
  if (opts.signal?.aborted) return interrupted();
  publishPlannerStatus(bus, state, 'running');
  bus.publish({ type: 'all_tasks_done', ts: Date.now(), phase: state.phase });

  let writeStatus: 'written' | 'failed' = 'written';
  let reviewText = '';
  let verdict: ParsedFinalReview | null = null;
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

    const reviewStep = { kind: 'review' as const, cycle: state.reviewFixes?.cycle ?? 0 };
    // One continuation, one call: the verdict re-ask is a fresh question, not a
    // second continuation of the attempt that was cut.
    let seed = opts.continuation?.take(reviewStep);

    const callReviewer = async (prompt: string): Promise<string> => {
      if (opts.sinks === undefined) {
        const review = await runReviewerCall({
          reviewer,
          prompt,
          projectDir,
          sessionId,
          bus,
          state,
          metadata,
          signal: opts.signal,
        });
        state = review.state;
        return review.text;
      }
      const loopSeed = seed;
      seed = undefined;
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
        step: reviewStep,
        ...(loopSeed === undefined ? {} : { seed: loopSeed }),
        onStateChange: (s) => {
          state = s;
        },
        // The review is one shot by constitution: a continuation re-issues the
        // whole deterministic prompt — spec, briefs, diff, drift, evidence — with
        // the operator's note on the end. It never resumes a session.
        body: ({ signal: callSignal, partial, steer }) =>
          runReviewerCall({
            reviewer,
            prompt:
              partial === undefined && steer === undefined
                ? prompt
                : composeContinuation({ basePrompt: prompt, partial, steer }),
            projectDir,
            sessionId,
            bus,
            state,
            metadata,
            signal: callSignal,
          }),
      });
      state = loop.value.state;
      return loop.value.text;
    };

    reviewText = await callReviewer(fullPrompt);
    verdict = parseFinalReview(reviewText);
    // A reply with no single verdict word cannot be acted on, and the reviewer
    // is the only party that can supply one; it gets exactly one more turn.
    if (verdict.verdict === null) {
      reviewText = await callReviewer(`${fullPrompt}\n\n${VERDICT_RULES.reaskSentence}`);
      verdict = parseFinalReview(reviewText);
    }
  } catch (err) {
    if (opts.signal?.aborted || isAbortError(err)) return interrupted();
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
    writeStatus = 'failed';
  }
  if (opts.signal?.aborted) return interrupted();

  try {
    const ledger = readEvidenceLedger({ projectDir, sessionId });
    if (ledger) {
      writeEvidenceLedger(
        { projectDir, sessionId },
        recordFinalReviewEvidence({ ledger, status: writeStatus }),
      );
    }
  } catch (err) {
    warnError('Failed to record final review evidence', err);
  }

  if (phaseTimings) phaseTimings.review = Date.now() - finalReviewStart;

  publishPlannerStatus(bus, state, 'done', {
    duration: Date.now() - finalReviewStart,
    ...(writeStatus === 'failed' && { summary: 'Final review failed' }),
  });

  try {
    await writeReviewPacket({
      projectDir,
      sessionId,
      summary: buildSummary({
        ...summaryBase,
        projectDir,
        sessionId,
        state,
        taskBreakdowns,
        ...(phaseTimings && { phaseTimings }),
      }),
      state,
      finalReviewStatus: writeStatus,
    });
  } catch (err) {
    publishWarningFromError(
      { bus: bus, phase: state.phase },
      'Review packet generation failed',
      err,
    );
  }

  const reviewStatus: ReviewPhaseStatus =
    writeStatus === 'failed'
      ? 'failed'
      : (verdict?.verdict ?? null) === null
        ? 'unparseable'
        : 'written';
  return { state, summaryBase, verdict, reviewText, reviewStatus };
}
